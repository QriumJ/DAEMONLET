"""Offline, parent-owned JSONL TTS worker. No training/lab imports or audio playback."""
from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import signal
import sys
import time
import wave
import uuid
from control import Inbox, StreamControl, StreamCancelled, stream_target, read_request
from backend import WorkerError, CudaDevice, MpsDevice, select_backend

PROTOCOL = sys.stdout
MODEL = "openbmb/VoxCPM2"
REVISION = "32279effe8c19989596f05d353d1447f51d9e915"
SOURCE = "f772e498a45fbb5fb8e13fbf9b9c48be9fe33e69"
ADAPTER = "e7d8b3b99af702c3df135ef194596c2b13cf99bb00b8e7204f684c435be50eb2"
CHECKSUMS = "1a7d036f437b611307dbdceca564af75424efa27f77f761a01c015de24005f4f"


def emit(kind, request_id, **data):
    PROTOCOL.write(json.dumps(dict(protocolVersion=1, type=kind, requestId=request_id, **data)) + "\n")
    PROTOCOL.flush()


def sha(path):
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def read_json(path):
    if path.stat().st_size > 1024 * 1024:
        raise ValueError("JSON_LIMIT")
    return json.loads(path.read_text(encoding="utf-8"))


def inside(root, name):
    if not isinstance(name, str) or "\\" in name or ":" in name or any(p in ("", ".", "..") for p in name.split("/")):
        raise ValueError("PATH")
    target = root / name
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("PATH")
    for p in [target, *target.parents]:
        if p.is_symlink() or (hasattr(p, "is_junction") and p.is_junction()):
            raise ValueError("LINK")
        if p == root:
            break
    return target


PUBLIC_ERRORS = {
    'VOICE_REFERENCE_CHANGED', 'VOICE_REFERENCE_RUNTIME', 'VOICE_REFERENCE_BINDING',
    "GGUF_CONVERSION_FAILED", "GGUF_CACHE_CHANGED", "GGUF_DISK_SPACE",
    "RUNTIME_POLICY", "RUNTIME_TENSORS", "RUNTIME_RECEIPT", "UNSUPPORTED_DEVICE", "JSON_LIMIT", "PATH", "LINK", "SELECTION_MISMATCH",
    "PACKAGE_CHANGED", "MODEL_REVISION", "MODEL_MANIFEST", "MODEL_CHANGED",
    "RUNTIME_SOURCE", "RUNTIME_VERSION", "RUNTIME_SOURCE_CHANGED", "ADAPTER_MISMATCH",
    "LORA_TENSORS", "LORA_INCOMPLETE", "UNSUPPORTED_STYLE", "SYNTHESIS_INPUT",
    "INVALID_WAVEFORM", "INVALID_WAV", "PROTOCOL_LIMIT", "PROTOCOL_VERSION",
    "ALREADY_INITIALIZED", "PROTOCOL_STATE", "EXECUTION_PROFILE", "COMPILE_UNAVAILABLE", "STREAM_CREDIT", "STREAM_CANCEL_BINDING", "STREAM_CLEANUP",
}


def error_code(error):
    if isinstance(error, (WorkerError, ValueError)) and str(error) in PUBLIC_ERRORS:
        return str(error)
    if isinstance(error, (ImportError, importlib.metadata.PackageNotFoundError)):
        return "RUNTIME_DEPENDENCY"
    if "out of memory" in str(error).lower():
        return "MPS_OOM" if "mps" in str(error).lower() else "CUDA_OOM"
    return "TTS_FAILED"


class Worker:
    def initialize(self, request):
        profile = request.get("executionProfile", "baseline")
        self.backend = select_backend(profile)
        started = time.perf_counter()
        phases = {}
        phase = started
        self.cache = Path(request["cache"])
        self.cache.mkdir(parents=True, exist_ok=True)
        # Native libraries and upstream progress messages cannot touch protocol stdout.
        os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_DATASETS_OFFLINE="1",
                          HF_HOME=str(self.cache / "hf"), TORCH_HOME=str(self.cache / "torch"),
                          NUMBA_CACHE_DIR=str(self.cache / "numba"), PYTHONDONTWRITEBYTECODE="1")
        import torch
        self.backend.require(torch)
        import soundfile
        phases['torchImportMs'] = (time.perf_counter()-phase)*1000
        phase = time.perf_counter()
        package = Path(request["package"])
        if sha(package / "checksums.sha256") != CHECKSUMS:
            raise ValueError("SELECTION_MISMATCH")
        for line in (package / "checksums.sha256").read_text(encoding="utf-8").splitlines():
            expected, name = line.split("  ", 1)
            if sha(inside(package, name)) != expected:
                raise ValueError("PACKAGE_CHANGED")
        self.voice = read_json(package / "voice.json")
        if self.voice["engine"]["source_commit"] != SOURCE or self.voice["checkpoint"] != "step_0002660":
            raise ValueError("SELECTION_MISMATCH")
        base = Path(request["model"])
        snapshot = read_json(base / "snapshot-provenance.json")
        if snapshot["model_id"] != MODEL or snapshot["revision"] != REVISION:
            raise ValueError("MODEL_REVISION")
        required = {"config.json", "audiovae.pth", "model.safetensors", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "tokenization_voxcpm2.py"}
        if not required.issubset(snapshot["files"]):
            raise ValueError("MODEL_MANIFEST")
        for name, expected in snapshot["files"].items():
            if sha(inside(base, name)) != expected:
                raise ValueError("MODEL_CHANGED")
        phases['fileValidationMs'] = (time.perf_counter()-phase)*1000
        phase = time.perf_counter()
        # An installation receipt is created only by the explicit setup tool.
        receipt = read_json(Path(sys.prefix) / "voice-runtime.json")
        if receipt["source_commit"] != SOURCE:
            raise ValueError("RUNTIME_SOURCE")
        if self.backend is MpsDevice:
            from macos_runtime import verify_runtime
            verify_runtime(receipt)
        else:
            for name, expected in self.voice["engine"]["runtime"].items():
                if importlib.metadata.version(name) != expected:
                    raise ValueError("RUNTIME_VERSION")
        from engine import Engine, runtime_fingerprint, PROFILES
        profile = request.get('executionProfile', 'baseline')
        if profile not in PROFILES:
            raise ValueError('EXECUTION_PROFILE')
        self.reference = inside(package, self.voice['reference'])
        identity = dict(model=REVISION, source=SOURCE, adapter=ADAPTER, package=CHECKSUMS, reference=sha(self.reference), **self.backend.identity(torch), python=sys.version, engine=sha(Path(__file__).with_name('engine.py')))
        fingerprint = runtime_fingerprint(profile, identity)
        if profile == 'compiled':
            compiler = Path(request['compilerCache']) / fingerprint
            compiler.mkdir(parents=True, exist_ok=True)
            os.environ.update(TORCHINDUCTOR_CACHE_DIR=str(compiler / 'inductor'), TRITON_CACHE_DIR=str(compiler / 'triton'), NUMBA_CACHE_DIR=str(compiler / 'numba'))
        import voxcpm
        source_root = Path(voxcpm.__file__).parent
        for name, expected in receipt["source_files"].items():
            if sha(inside(source_root, name)) != expected:
                raise ValueError("RUNTIME_SOURCE_CHANGED")
        from voxcpm import VoxCPM
        from voxcpm.model.voxcpm2 import LoRAConfig
        from safetensors.torch import load_file
        phases['upstreamImportMs'] = (time.perf_counter()-phase)*1000
        phase = time.perf_counter()
        lora = inside(package, self.voice["lora"])
        if sha(lora / "lora_weights.safetensors") != ADAPTER:
            raise ValueError("ADAPTER_MISMATCH")
        config = read_json(lora / "lora_config.json")
        self.model = VoxCPM.from_pretrained(str(base), device=self.backend.device, optimize=False, load_denoiser=False,
                                          local_files_only=True, lora_config=LoRAConfig(**config["lora_config"]))
        self.backend.synchronize(torch)
        phases['modelLoadMs'] = (time.perf_counter()-phase)*1000
        phase = time.perf_counter()
        tensors = load_file(str(lora / "lora_weights.safetensors"))
        parameters = dict(self.model.tts_model.named_parameters())
        expected = {k for k in parameters if "lora_" in k}
        if len(tensors) != 384 or set(tensors) != expected or not all(v.shape == parameters[k].shape and torch.isfinite(v).all().item() for k, v in tensors.items()):
            raise ValueError("LORA_TENSORS")
        loaded, skipped = self.model.tts_model.load_lora_weights(str(lora))
        if skipped or expected != set(loaded):
            raise ValueError("LORA_INCOMPLETE")
        self.reference = inside(package, self.voice["reference"])
        self.settings = {k: self.voice["inference"][k] for k in ("cfg_value", "inference_timesteps", "normalize", "denoise", "retry_badcase", "max_len", "seed")}
        self.model.tts_model.eval()
        self.backend.synchronize(torch)
        phases['adapterAuditLoadMs'] = (time.perf_counter()-phase)*1000
        self.engine = Engine(self.model, self.reference, self.settings, profile, self.backend)
        tensor_audit = self.backend.audit_model(self.model.tts_model, torch) if self.backend is MpsDevice else {}
        self.engine.prepare()
        if request.get('warmup', True):
            self.engine.warmup()
        self.vae_forwards = [(mod, mod.forward) for mod in self.model.tts_model.audio_vae.decoder.modules()]
        return dict(workerPid=os.getpid(), loadMs=(time.perf_counter()-started)*1000, loadedKeys=len(loaded), skippedKeys=len(skipped), missingKeys=len(expected-set(loaded)), tensorAudit=tensor_audit, backend=self.backend.device, dtype=self.backend.dtype, adapterSha256=ADAPTER,
                    modelRevision=REVISION, sourceCommit=SOURCE, referenceSha256=sha(self.reference), executionProfile=profile, runtimeFingerprint=fingerprint, phases=phases, compileWarningsCaptured=False, referenceCacheBuilds=self.engine.cache_builds, firstInferenceAfterCompileMs=self.engine.audit.get('warmupMs') if profile == 'compiled' else None, **self.engine.audit)

    def synthesize(self, request):
        import numpy as np
        import soundfile as sf
        import torch
        if request.get("style") is not None:
            raise ValueError("UNSUPPORTED_STYLE")
        text = request["text"]
        audio_id = request["audioId"]
        if not isinstance(text, str) or not text.strip() or len(text) > 400 or not re.fullmatch(r"[a-f0-9-]{36}", audio_id):
            raise ValueError("SYNTHESIS_INPUT")
        self.backend.synchronize(torch)
        self.backend.begin_measurement(torch)
        start = time.perf_counter()
        with contextlib.closing(self.engine.generate(text)) as generated:
            audio = next(generated)
        self.backend.synchronize(torch)
        elapsed = (time.perf_counter()-start)*1000
        audio = np.asarray(audio)
        sr = int(self.model.tts_model.sample_rate)
        if sr != 48000 or audio.ndim != 1 or not 0 < audio.size <= sr * 60 or not np.isfinite(audio).all() or np.max(np.abs(audio)) < 1e-7:
            raise ValueError("INVALID_WAVEFORM")
        temporary = self.cache / (audio_id + ".partial")
        output = self.cache / (audio_id + ".wav")
        sf.write(temporary, audio, sr, format="WAV", subtype="PCM_16")
        with wave.open(str(temporary), "rb") as wav:
            if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth(), wav.getnframes()) != (48000, 1, 2, len(audio)):
                raise ValueError("INVALID_WAV")
        temporary.replace(output)
        duration = len(audio) / sr * 1000
        return dict(audioId=audio_id, binding=request["binding"], segmentIndex=request["segmentIndex"],
                    sampleRate=sr, durationMs=duration, generationMs=elapsed, rtf=elapsed/duration,
                    **self.backend.memory(torch))

    def stream(self, request, credit):
        import numpy as np
        import soundfile as sf
        import torch
        if int(self.model.tts_model.sample_rate) != 48000:
            raise ValueError('INVALID_WAVEFORM')
        text = request.get('text')
        if request.get('streamVersion') != 1 or not isinstance(text, str) or not text.strip() or len(text) > 400 or request.get('style') is not None:
            raise ValueError('SYNTHESIS_INPUT')
        start = time.perf_counter()
        self.backend.begin_measurement(torch)
        total = chunks = 0
        peak = blocked = 0
        first = onset = None
        self.stream_files = []

        # Three 160ms chunks in flight; parent credits are returned on playback.
        with contextlib.closing(self.engine.generate(text, streaming=True)) as generated:
            while True:
                waited = time.perf_counter()
                credit(chunks)
                blocked += (time.perf_counter()-waited)*1000
                try:
                    audio = np.asarray(next(generated))
                except StopIteration:
                    break
                # IO can request cancellation while next() owns the GPU. Observe
                # it here, before publishing the completed chunk, on this thread.
                if hasattr(credit, 'checkpoint'):
                    credit.checkpoint(chunks)
                if audio.ndim != 1 or not 0 < audio.size <= 48000 or not np.isfinite(audio).all() or total + audio.size > 48000*60:
                    raise ValueError('INVALID_WAVEFORM')
                magnitude = float(np.max(np.abs(audio)))
                peak = max(peak, magnitude)
                audio_id = str(uuid.uuid4())
                path = self.cache / (audio_id + '.wav')
                self.stream_files.append(path)
                sf.write(path, audio, 48000, format='WAV', subtype='PCM_16')
                elapsed = (time.perf_counter()-start)*1000
                if first is None:
                    first = elapsed
                if onset is None and magnitude >= 1e-7:
                    onset = elapsed
                emit('audio-chunk', request['requestId'], audioId=audio_id, binding=request['binding'], synthesisId=request['synthesisId'], segmentIndex=request['segmentIndex'], chunkIndex=chunks, sampleOffset=total, sampleCount=int(audio.size), sampleRate=48000, firstChunkReadyMs=first)
                total += audio.size
                chunks += 1
        self.backend.synchronize(torch)
        if peak < 1e-7 or not total:
            raise ValueError('INVALID_WAVEFORM')
        elapsed = (time.perf_counter()-start)*1000
        return dict(synthesisId=request['synthesisId'], totalSamples=total, totalChunks=chunks, firstChunkReadyMs=first, firstSignalChunkReadyMs=onset, generationMs=elapsed, producerBlockedMs=blocked, rtf=elapsed/(total/48), **self.backend.memory(torch))

    def reuse_audit(self):
        return dict(referenceCacheBuilds=self.engine.cache_builds, compileCounts=self.engine.compile_counts)

    def cancel_stream(self):
        # Engine.generate's finally closes the pinned upstream generator. Its
        # StreamingVAEDecoder.__exit__ restores forwards and drops conv state.
        # Verify that restoration, and clear static KV storage in place so CUDA
        # graph addresses survive. The fixed reference prompt cache is untouched.
        import torch
        if any(mod.forward != original for mod, original in self.vae_forwards):
            raise ValueError('STREAM_CLEANUP')
        with torch.inference_mode():
            for lm in (self.model.tts_model.base_lm, self.model.tts_model.residual_lm):
                lm.kv_cache.kv_cache.zero_()
                lm.kv_cache.current_length = 0
        self.backend.synchronize(torch)
        for path in getattr(self, 'stream_files', []):
            path.unlink(missing_ok=True)
        self.stream_files = []


def main():
    worker = None
    tails = {}
    def consume_tail(value):
        ident = value.get('requestId')
        if ident not in tails:
            return False
        index, total = tails[ident]
        if value != dict(protocolVersion=1, type='credit', requestId=ident, chunkIndex=index):
            raise ValueError('STREAM_CREDIT')
        if index + 1 == total:
            del tails[ident]
        else:
            tails[ident] = (index+1, total)
        return True
    inbox = None
    last_target = None
    try:
        while True:
            request_id = None
            try:
                request = inbox.take() if inbox else read_request(sys.stdin)
                request_id = request['requestId']
                kind = request['type']
                if kind == 'credit' and consume_tail(request):
                    continue
                if kind == 'init':
                    if worker:
                        raise ValueError('ALREADY_INITIALIZED')
                    if request.get('baseModel') is True:
                        from windows_base_worker import create_worker
                        candidate = create_worker(Worker)()
                    elif request.get('executionProfile') == 'gguf-metal-f16':
                        from gguf_worker import GgufWorker
                        candidate = GgufWorker(emit)
                    else:
                        candidate = Worker()
                    try:
                        audit = candidate.initialize(request)
                    except BaseException:
                        if hasattr(candidate, 'close'):
                            candidate.close()
                        raise
                    worker = candidate
                    # NumPy's Windows native import can block behind a reader's
                    # CRT stdin lock. Load/warm native dependencies before the
                    # reader starts; initialization still uses kill fallback.
                    inbox = Inbox(sys.stdin)
                    emit('ready', request_id, **audit)
                elif kind == 'health':
                    emit('ready', request_id, initialized=worker is not None)
                elif kind == 'synthesize' and worker:
                    emit('synthesis-started', request_id)
                    emit('audio-ready', request_id, **worker.synthesize(request))
                elif kind == 'stream' and worker:
                    last_target = stream_target(request)
                    emit('synthesis-started', request_id)
                    control = StreamControl(inbox, request, consume_tail)
                    try:
                        result = worker.stream(request, control)
                    except StreamCancelled as cancelled:
                        worker.cancel_stream()
                        tails.pop(request_id, None)
                        emit('cancelled', cancelled.request['requestId'], target=last_target, cleanupComplete=True, keptWarm=True, boundary=cancelled.boundary, reuseAudit=worker.reuse_audit())
                        continue
                    if control.received < result['totalChunks']:
                        if len(tails) >= 2:
                            raise ValueError('STREAM_CREDIT')
                        tails[request_id] = (control.received, result['totalChunks'])
                    emit('synthesis-finished', request_id, **result)
                elif kind == 'cancel-stream' and worker:
                    # Terminal response may race cancellation on the parent pipe.
                    if last_target is None or request.get('target') != last_target:
                        raise ValueError('STREAM_CANCEL_BINDING')
                    worker.cancel_stream()
                    tails.pop(last_target['requestId'], None)
                    emit('cancelled', request_id, target=last_target, cleanupComplete=True, keptWarm=True, boundary='terminal', reuseAudit=worker.reuse_audit())
                elif kind == 'cancel':
                    emit('cancelled', request_id)
                elif kind == 'shutdown':
                    emit('cancelled', request_id)
                    return
                else:
                    raise ValueError('PROTOCOL_STATE')
            except EOFError:
                return
            except Exception as error:
                emit('error', request_id, code=error_code(error))
                return
    finally:
        if inbox:
            inbox.close()
        if worker and hasattr(worker, "close"):
            worker.close()


if __name__ == "__main__":
    sys.stdout = sys.stderr
    # Redirect file descriptor 1 as well, retaining a dedicated protocol handle.
    PROTOCOL = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)
    if sys.platform == "darwin":
        def terminate(*_):
            raise SystemExit(0)
        signal.signal(signal.SIGTERM, terminate)
    main()
