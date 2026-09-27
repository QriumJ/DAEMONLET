"""Offline, parent-owned JSONL TTS worker. No training/lab imports or audio playback."""
from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import time
import wave

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


class WorkerError(Exception):
    """Expected public errors; never transmit arbitrary exception messages."""


PUBLIC_ERRORS = {
    "UNSUPPORTED_DEVICE", "JSON_LIMIT", "PATH", "LINK", "SELECTION_MISMATCH",
    "PACKAGE_CHANGED", "MODEL_REVISION", "MODEL_MANIFEST", "MODEL_CHANGED",
    "RUNTIME_SOURCE", "RUNTIME_VERSION", "RUNTIME_SOURCE_CHANGED", "ADAPTER_MISMATCH",
    "LORA_TENSORS", "LORA_INCOMPLETE", "UNSUPPORTED_STYLE", "SYNTHESIS_INPUT",
    "INVALID_WAVEFORM", "INVALID_WAV", "PROTOCOL_LIMIT", "PROTOCOL_VERSION",
    "ALREADY_INITIALIZED", "PROTOCOL_STATE",
}


def error_code(error):
    if isinstance(error, (WorkerError, ValueError)) and str(error) in PUBLIC_ERRORS:
        return str(error)
    if "out of memory" in str(error).lower():
        return "CUDA_OOM"
    return "TTS_FAILED"


class CudaDevice:
    @staticmethod
    def require(torch):
        CudaDevice.require_platform()
        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise WorkerError("UNSUPPORTED_DEVICE")

    @staticmethod
    def require_platform():
        if sys.platform != "win32":
            raise WorkerError("UNSUPPORTED_DEVICE")


class Worker:
    def initialize(self, request):
        CudaDevice.require_platform()
        started = time.perf_counter()
        self.cache = Path(request["cache"])
        self.cache.mkdir(parents=True, exist_ok=True)
        # Native libraries and upstream progress messages cannot touch protocol stdout.
        os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_DATASETS_OFFLINE="1",
                          HF_HOME=str(self.cache / "hf"), TORCH_HOME=str(self.cache / "torch"),
                          NUMBA_CACHE_DIR=str(self.cache / "numba"), PYTHONDONTWRITEBYTECODE="1")
        import torch
        CudaDevice.require(torch)
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
        # An installation receipt is created only by the explicit setup tool.
        receipt = read_json(Path(sys.prefix) / "voice-runtime.json")
        if receipt["source_commit"] != SOURCE:
            raise ValueError("RUNTIME_SOURCE")
        for name, expected in self.voice["engine"]["runtime"].items():
            if importlib.metadata.version(name) != expected:
                raise ValueError("RUNTIME_VERSION")
        import voxcpm
        source_root = Path(voxcpm.__file__).parent
        for name, expected in receipt["source_files"].items():
            if sha(inside(source_root, name)) != expected:
                raise ValueError("RUNTIME_SOURCE_CHANGED")
        from voxcpm import VoxCPM
        from voxcpm.model.voxcpm2 import LoRAConfig
        from safetensors.torch import load_file
        lora = inside(package, self.voice["lora"])
        if sha(lora / "lora_weights.safetensors") != ADAPTER:
            raise ValueError("ADAPTER_MISMATCH")
        config = read_json(lora / "lora_config.json")
        self.model = VoxCPM.from_pretrained(str(base), device="cuda", optimize=False, load_denoiser=False,
                                          local_files_only=True, lora_config=LoRAConfig(**config["lora_config"]))
        tensors = load_file(str(lora / "lora_weights.safetensors"))
        expected = {k for k, _ in self.model.tts_model.named_parameters() if "lora_" in k}
        if len(tensors) != 384 or set(tensors) != expected or not all(torch.isfinite(v).all().item() for v in tensors.values()):
            raise ValueError("LORA_TENSORS")
        loaded, skipped = self.model.tts_model.load_lora_weights(str(lora))
        if skipped or expected != set(loaded):
            raise ValueError("LORA_INCOMPLETE")
        self.reference = inside(package, self.voice["reference"])
        self.settings = {k: self.voice["inference"][k] for k in ("cfg_value", "inference_timesteps", "normalize", "denoise", "retry_badcase", "max_len", "seed")}
        torch.cuda.synchronize()
        return dict(loadMs=(time.perf_counter()-started)*1000, loadedKeys=len(loaded), adapterSha256=ADAPTER,
                    modelRevision=REVISION, sourceCommit=SOURCE, referenceSha256=sha(self.reference))

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
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
        start = time.perf_counter()
        audio = self.model.generate(text=text, reference_wav_path=str(self.reference), **self.settings)
        torch.cuda.synchronize()
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
                    peakAllocatedBytes=torch.cuda.max_memory_allocated(), peakReservedBytes=torch.cuda.max_memory_reserved())


def main():
    worker = None
    while True:
        line = sys.stdin.readline(65537)
        if not line:
            return
        request_id = None
        try:
            if len(line) > 65536 or not line.endswith("\n"):
                raise ValueError("PROTOCOL_LIMIT")
            request = json.loads(line)
            request_id = request.get("requestId")
            if request.get("protocolVersion") != 1 or not isinstance(request_id, str):
                raise ValueError("PROTOCOL_VERSION")
            kind = request["type"]
            if kind == "init":
                if worker:
                    raise ValueError("ALREADY_INITIALIZED")
                candidate = Worker()
                audit = candidate.initialize(request)
                worker = candidate
                emit("ready", request_id, **audit)
            elif kind == "health":
                emit("ready", request_id, initialized=worker is not None)
            elif kind == "synthesize" and worker:
                emit("synthesis-started", request_id)
                emit("audio-ready", request_id, **worker.synthesize(request))
            elif kind == "cancel":
                # While generate is blocking, the parent kills this owned process.
                emit("cancelled", request_id)
            elif kind == "shutdown":
                emit("cancelled", request_id)
                return
            else:
                raise ValueError("PROTOCOL_STATE")
        except Exception as error:
            code = error_code(error)
            emit("error", request_id, code=code)
            # Fail closed: no base-voice fallback, no surviving partially loaded CUDA model.
            return


if __name__ == "__main__":
    sys.stdout = sys.stderr
    # Redirect file descriptor 1 as well, retaining a dedicated protocol handle.
    PROTOCOL = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)
    main()
