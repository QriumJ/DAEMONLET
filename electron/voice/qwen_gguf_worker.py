"""Pinned external Qwen Base Q8 GPU worker; no downloads or Torch imports.

Native PCM callbacks feed protocol 1 with three transport credits. A callback
never lets a Python exception cross the C ABI. Cancellation is acknowledged
only after qt_synthesize retires the native job and its output is freed.
"""
import contextlib
import ctypes as C
import hashlib
import importlib.metadata as metadata
import json
import math
import os
from pathlib import Path
import platform
import re
import stat
import sys
import threading
import time
import uuid
import wave

# Managed Python starts with -I, which excludes the script directory. This
# app-owned sibling directory supplies the bundled protocol/admission modules.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from control import read_request, Inbox, StreamControl, StreamCancelled, stream_target
from qwen_audio import pcm48, IncrementalPcm
from qwen_memory import process_memory
from reference_condition import verify_reference_condition
from windows_model_check import check_gguf_model
from managed_gguf_runtime import admit as admit_managed_runtime, audit as managed_audit, verify_gpu_support
from qwen_gguf_abi import ABI_VERSION, Init, Audio, Ref, Params, CancelCB, ChunkCB, LogCB, bind, bind_devices, verify_layout

POLICY = json.loads(Path(__file__).with_name('runtime-qwen-gguf-windows.json').read_text(encoding='utf-8'))
ENGINE = POLICY['engine']
REVISION = POLICY['modelRevision']
PROFILE_BACKENDS = {'qwen-gguf':'cuda', 'qwen-gguf-complete':'cuda',
                    'qwen-gguf-vulkan':'vulkan', 'qwen-gguf-vulkan-complete':'vulkan'}
PROFILES = tuple(PROFILE_BACKENDS)
CAPABILITIES = dict(engine=ENGINE, backend='cuda:0', abiVersion=ABI_VERSION,
                    synthesisStreaming=True, transportChunking=False,
                    cancellation='cooperative-with-process-fallback', warmCancellationReuse=True,
                    referenceModes=['x-vector', 'icl'], sampleRate=48000, channels=1,
                    encoding='pcm16', maxSeconds=60)
PROTOCOL = sys.stdout


def emit(kind, rid, **fields):
    PROTOCOL.write(json.dumps(dict(protocolVersion=1, type=kind, requestId=rid, **fields), ensure_ascii=True) + '\n')
    PROTOCOL.flush()


def backend_policy(profile):
    family = PROFILE_BACKENDS.get(profile)
    if family is None:
        raise ValueError('QWEN_EXECUTION_PROFILE')
    policy = POLICY.get('backends', {}).get(family)
    if not isinstance(policy, dict) or not isinstance(policy.get('binaries'), dict) or not policy['binaries']:
        raise ValueError('QWEN_GGUF_BACKEND_UNAPPROVED')
    if (policy.get('device'), policy.get('backend')) != (('CUDA0', 'cuda:0') if family == 'cuda' else ('Vulkan0', 'vulkan:0')):
        raise ValueError('QWEN_GGUF_BACKEND_UNAPPROVED')
    return policy


def capabilities_for(profile):
    selected = backend_policy(profile)
    return dict(CAPABILITIES, backend=selected['backend'], backendDevice=selected['device'])


def configure_backend_environment(selected):
    # Changes apply only to this owned process. An inherited ggml plugin path
    # must not execute an unrelated DLL before the forced backend is selected.
    os.environ.pop('GGML_BACKEND_PATH', None)
    os.environ['GGML_BACKEND'] = selected['device']
    if selected['device'] == 'Vulkan0':
        # The pinned default Vulkan enumeration excludes physical CPU devices;
        # an explicit index override would bypass that filter. Use the installed
        # vendor driver without optional developer layers or out-of-tree ICDs.
        for key in ('GGML_VK_VISIBLE_DEVICES', 'VK_ICD_FILENAMES', 'VK_DRIVER_FILES', 'VK_ADD_DRIVER_FILES',
                    'VK_INSTANCE_LAYERS', 'VK_LAYER_PATH', 'VK_ADD_LAYER_PATH', 'VK_IMPLICIT_LAYER_PATH',
                    'VK_ADD_IMPLICIT_LAYER_PATH', 'VK_LOADER_LAYERS_ENABLE', 'VK_LOADER_LAYERS_ALLOW'):
            os.environ.pop(key, None)
        os.environ['VK_LOADER_LAYERS_DISABLE'] = '~all~'


def inspect_device(lib, selected):
    """Require the forced named GPU, while reporting CPU operator fallback."""
    expected = selected['device'].encode('ascii')
    device = lib.ggml_backend_dev_by_name(expected)
    if not device or lib.ggml_backend_dev_name(device) != expected or lib.ggml_backend_dev_type(device) not in (1, 2):
        # ggml enum values 1/2 are GPU/IGPU; CPU, BLAS and meta devices are
        # ineligible even if a driver or registry supplies a misleading name.
        raise ValueError('QWEN_GGUF_GPU_REQUIRED')
    description = lib.ggml_backend_dev_description(device)
    if not description:
        raise ValueError('QWEN_GGUF_GPU_REQUIRED')
    free = C.c_size_t(); total = C.c_size_t()
    lib.ggml_backend_dev_memory(device, C.byref(free), C.byref(total))
    return dict(backendDevice=selected['device'], gpuDeviceName=description.decode('utf-8', errors='replace'),
                gpuDeviceType='dedicated' if lib.ggml_backend_dev_type(device) == 1 else 'integrated',
                gpuFreeBytes=free.value, gpuTotalBytes=total.value, cpuOperatorFallback=True)


def ordinary(path):
    try:
        if not path.is_absolute() or '..' in path.parts:
            raise ValueError()
        for entry in (path, *path.parents):
            s = entry.lstat()
            if entry.is_symlink() or getattr(s, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400):
                raise ValueError()
    except (OSError, ValueError):
        raise ValueError('QWEN_GGUF_ASSET_CHANGED') from None


def sha(path):
    ordinary(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError('QWEN_GGUF_ASSET_CHANGED')
        result = hashlib.file_digest(stream, 'sha256').hexdigest()
        after = os.fstat(stream.fileno())
    if any(getattr(before, key) != getattr(after, key) for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')):
        raise ValueError('QWEN_GGUF_ASSET_CHANGED')
    return result


def verify_native(root, profile='qwen-gguf'):
    selected = backend_policy(profile)
    ordinary(root)
    if not root.is_dir():
        raise ValueError('QWEN_GGUF_RUNTIME_CHANGED')
    for name, expected in selected['binaries'].items():
        path = root / name
        if not path.is_file() or path.stat().st_size != expected['bytes'] or sha(path) != expected['sha256']:
            raise ValueError('QWEN_GGUF_RUNTIME_CHANGED')
    # ggml probes only backend DLL candidates. Reject every extra DLL rather
    # than loading an unreviewed variant. Adjacent EXEs/build tools may exist,
    # but this worker never launches them, imports from this folder, or admits
    # them for execution. Absolute DLL loads use restricted dependent searches.
    for path in root.rglob('*'):
        ordinary(path)
        if path.is_file() and path.suffix.lower() == '.dll' and path.relative_to(root).as_posix() not in selected['binaries']:
            raise ValueError('QWEN_GGUF_RUNTIME_CHANGED')


def verify_environment(managed=None):
    if sys.platform != 'win32' or platform.machine().lower() not in ('amd64', 'x86_64') or C.sizeof(C.c_void_p) != 8:
        raise ValueError('QWEN_GGUF_PLATFORM_REQUIRED')
    if (platform.python_version() != POLICY['python']
            or (sys.prefix == sys.base_prefix and (not managed or managed.get('verified') is not True
                or Path(sys.executable).resolve() != managed['python']))):
        raise ValueError('QWEN_GGUF_RUNTIME_VERSION')
    for name, expected in POLICY['dependencies'].items():
        try:
            actual = metadata.version(name)
        except metadata.PackageNotFoundError:
            raise ValueError('QWEN_GGUF_RUNTIME_VERSION') from None
        if actual != expected:
            raise ValueError('QWEN_GGUF_RUNTIME_VERSION')


def prompt_key(reference_sha, transcript, mode, profile='qwen-gguf'):
    selected = backend_policy(profile)
    return hashlib.sha256(json.dumps([ENGINE, POLICY['sourceCommit'], POLICY['ggmlCommit'], REVISION,
                                     selected['backend'], reference_sha, hashlib.sha256(transcript.encode()).hexdigest(), mode],
                                    separators=(',', ':')).encode()).hexdigest()


class GgufWorker:
    def __init__(self):
        self.lib = None
        self.context = None
        self.reference = Ref()
        self.dll_dirs = []
        self.stream_files = []
        self.native_active = False
        self.native_cleanup_complete = True
        self.closed = False
        self.warmed = False

    def initialize(self, request):
        begin = time.perf_counter()
        self.profile = request.get('executionProfile')
        if request.get('engine') != ENGINE or self.profile not in PROFILES:
            raise ValueError('QWEN_EXECUTION_PROFILE')
        self.backend = backend_policy(self.profile)
        self.session = str(uuid.UUID(request['runtimeSessionId']))
        if self.session != request['runtimeSessionId']:
            raise ValueError('VOICE_SESSION')
        self.cache = Path(request['cache']); ordinary(self.cache)
        self.conditioning = verify_reference_condition(request['conditioning'], self.cache)
        settings = request.get('qwen', {})
        self.mode = settings.get('mode', 'x-vector'); self.transcript = settings.get('transcript', '')
        if self.mode not in ('x-vector', 'icl') or not isinstance(self.transcript, str) or len(self.transcript) > 2000 or any(ord(c) < 32 and c not in '\n\t' for c in self.transcript):
            raise ValueError('QWEN_REFERENCE_MODE')
        if self.mode == 'icl' and not self.transcript.strip():
            raise ValueError('QWEN_TRANSCRIPT_REQUIRED')
        if self.mode == 'x-vector':
            self.transcript = ''
        self.promptKey = prompt_key(self.conditioning['sha256'], self.transcript, self.mode, self.profile)
        self.raw = request.get('keepRaw') is True
        model = Path(request['model']); native = Path(request['ggufRuntime'])
        # Manual pairs and exact managed public receipts are eligible. Neither
        # can skip full weight hashes when another engine prefers fast checks.
        audit = check_gguf_model(model, POLICY)
        self.managed = admit_managed_runtime(request.get('managedRuntime'), POLICY,
                                            'qwen-' + PROFILE_BACKENDS[self.profile], native)
        model_verified = time.perf_counter(); verify_environment(self.managed); verify_native(native, self.profile)
        managed_gpu = verify_gpu_support(self.managed)
        verify_layout(POLICY['abiLayout'])
        # The pinned ggml scans the process executable directory and cwd. Both
        # are outside the DLL folder; no extra backend there may be executed.
        for directory in {Path(sys.executable).parent, Path(getattr(sys, '_base_executable', sys.executable)).parent, Path.cwd()}:
            ordinary(directory)
            if any(p.is_file() and p.name.lower().startswith('ggml-') and p.suffix.lower() == '.dll' for p in directory.iterdir()):
                raise ValueError('QWEN_GGUF_RUNTIME_CHANGED')
        configure_backend_environment(self.backend)
        self.dll_dirs.append(os.add_dll_directory(str(native)))
        if self.managed:
            for directory in self.managed['dependencyDirs']:
                self.dll_dirs.append(os.add_dll_directory(str(directory)))
        elif PROFILE_BACKENDS[self.profile] == 'cuda':
            cuda = Path(r'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA') / ('v' + POLICY['cudaVersion']) / 'bin'
            for directory in (cuda, cuda / 'x64'):
                if directory.is_dir():
                    ordinary(directory); self.dll_dirs.append(os.add_dll_directory(str(directory)))
        environment_done = time.perf_counter()
        import numpy as np
        import soundfile as sf
        from scipy.signal import resample_poly
        imported = time.perf_counter()
        # Restrict dependent library resolution to registered process-local
        # directories and Windows system directories, without changing PATH.
        self.lib = bind(C.CDLL(str(native / 'qwen.dll'), winmode=0x1100))
        try:
            self.devices = bind_devices(C.CDLL(str(native / 'ggml.dll'), winmode=0x1100),
                                        C.CDLL(str(native / 'ggml-base.dll'), winmode=0x1100))
        except AttributeError:
            raise ValueError('QWEN_GGUF_ABI') from None
        self.backend_seen = False; self.log_failed = False; self.log_lock = threading.Lock()
        def logged(level, message, _):
            try:
                text = message.decode('utf-8', errors='replace') if message else ''
                with self.log_lock:
                    if re.fullmatch(r'\[Load\] Talker backend: '+re.escape(self.backend['device'])+r' \(CPU threads: \d+\)', text):
                        self.backend_seen = True
                if level >= 2:
                    sys.stderr.write(text[:1000] + '\n'); sys.stderr.flush()
            except BaseException:
                self.log_failed = True
        self.log_callback = LogCB(logged); self.lib.qt_log_set(self.log_callback, None)
        init = Init(); self.lib.qt_init_default_params(C.byref(init))
        if init.abi_version != ABI_VERSION:
            raise ValueError('QWEN_GGUF_ABI')
        init.talker_path = str(model / 'qwen-talker-0.6b-base-Q8_0.gguf').encode('utf-8')
        init.codec_path = str(model / 'qwen-tokenizer-12hz-Q8_0.gguf').encode('utf-8')
        init.max_batch = 1
        self.context = self.lib.qt_init(C.byref(init))
        if not self.context or not self.backend_seen or self.log_failed:
            raise ValueError('QWEN_GGUF_CUDA_REQUIRED' if PROFILE_BACKENDS[self.profile] == 'cuda' else 'QWEN_GGUF_VULKAN_REQUIRED')
        device_audit = inspect_device(self.devices, self.backend)
        if self.lib.qt_model_type(self.context) != b'base':
            raise ValueError('QWEN_GGUF_BASE_REQUIRED')
        loaded = time.perf_counter()
        audio, rate = sf.read(self.conditioning['path'], dtype='float32', always_2d=True)
        if audio.shape[1] != 1:
            raise ValueError('VOICE_REFERENCE_CHANGED')
        audio = audio[:, 0]
        if rate != 24000:
            factor = math.gcd(rate, 24000); audio = resample_poly(audio, 24000 // factor, rate // factor)
        audio = np.ascontiguousarray(audio, dtype=np.float32)
        if not 24000 <= audio.size <= 24000 * 30 or not np.isfinite(audio).all():
            raise ValueError('VOICE_REFERENCE_CHANGED')
        rc = self.lib.qt_extract_voice_ref(self.context, audio.ctypes.data_as(C.POINTER(C.c_float)), int(audio.size), C.byref(self.reference))
        if rc != 0 or not self.reference.ref_spk_emb or self.reference.ref_spk_dim != 1024 or not self.reference.ref_codes or self.reference.num_codebooks != 16 or not 0 < self.reference.ref_T <= 375:
            raise ValueError('QWEN_GGUF_REFERENCE_PREP')
        if not np.isfinite(np.ctypeslib.as_array(self.reference.ref_spk_emb, shape=(self.reference.ref_spk_dim,))).all():
            raise ValueError('QWEN_GGUF_REFERENCE_PREP')
        # Re-check DLL metadata/content after model load. No mutable receipt is
        # allowed to make an unreviewed native build eligible.
        verify_native(native, self.profile)
        return dict(seedContract=1, referenceContract=1, mode='wav-reference', referenceSha256=self.conditioning['sha256'],
                    conditioningFingerprint=self.conditioning['fingerprint'], referenceCacheBuilds=1, adapterSha256=None,
                    defaultVoice=None, modelRevision=REVISION, sourceCommit=POLICY['sourceCommit'], ggmlCommit=POLICY['ggmlCommit'],
                    runtimeFingerprint=self.promptKey, promptCacheKey=self.promptKey, backend=self.backend['backend'], abiVersion=ABI_VERSION,
                    **audit, environmentCheckMs=(environment_done-model_verified)*1000,
                    runtimeImportMs=(imported-environment_done)*1000, modelLoadMs=(loaded-imported)*1000,
                    loadMs=(loaded-begin)*1000, promptMs=(time.perf_counter()-loaded)*1000,
                    loaded=True, warmed=False, ready=True, workerPid=os.getpid(), capabilities=capabilities_for(self.profile),
                    **managed_audit(self.managed),
                    **managed_gpu,
                    **device_audit,
                    dtype='Q8_0', attention='flash', **process_memory())

    def validate(self, request):
        binding = request.get('binding', {})
        if binding.get('runtimeSessionId') != self.session:
            raise ValueError('VOICE_SESSION')
        if binding.get('conditioningFingerprint') != self.conditioning['fingerprint']:
            raise ValueError('VOICE_REFERENCE_BINDING')
        if binding.get('engine') != ENGINE or binding.get('executionProfile') != self.profile:
            raise ValueError('QWEN_EXECUTION_PROFILE')
        if type(binding.get('speechEpoch')) is not int or binding['speechEpoch'] < 0 or type(request.get('segmentIndex')) is not int or request['segmentIndex'] < 0:
            raise ValueError('VOICE_AUDIO_BINDING')
        if binding.get('effectiveSeed') != request.get('seed'):
            raise ValueError('VOICE_SEED_MISMATCH')
        if type(request.get('seed')) is not int or not 1 <= request['seed'] <= 2147483647:
            raise ValueError('VOICE_SEED_INVALID')
        text = request.get('text')
        if not isinstance(text, str) or not text.strip() or len(text) > 600 or '\x00' in text:
            raise ValueError('VOICE_MESSAGE')
        return text

    def params(self, text, seed):
        if self.closed or not self.context or self.native_active:
            raise ValueError('QWEN_PROTOCOL')
        if type(seed) is not int or not 1 <= seed <= 2147483647:
            raise ValueError('VOICE_SEED_INVALID')
        params = Params(); self.lib.qt_tts_default_params(C.byref(params))
        if params.abi_version != ABI_VERSION:
            raise ValueError('QWEN_GGUF_ABI')
        params.text = text.encode('utf-8'); params.lang = b'Auto'; params.seed = seed
        sampling = POLICY['sampling']; params.max_new_tokens = sampling['maxNewTokens']
        params.temperature = params.subtalker_temperature = sampling['temperature']
        params.top_k = params.subtalker_top_k = sampling['topK']
        params.top_p = params.subtalker_top_p = sampling['topP']; params.repetition_penalty = sampling['repetitionPenalty']
        params.ref_spk_emb = self.reference.ref_spk_emb; params.ref_spk_dim = self.reference.ref_spk_dim
        if self.mode == 'icl':
            params.ref_text = self.transcript.encode('utf-8'); params.ref_codes = self.reference.ref_codes; params.ref_T = self.reference.ref_T
        return params

    def invoke(self, params, callback=None, checkpoint=None):
        """Keep callbacks live until native retirement; propagate errors afterward."""
        import numpy as np
        failure = []; samples = 0
        def failed(error):
            if not failure:
                failure.append(error)
        def cancel(_):
            try:
                if failure:
                    return True
                if checkpoint:
                    checkpoint()
                return False
            except BaseException as error:
                failed(error); return True
        def chunk(pointer, count, _):
            nonlocal samples
            try:
                if failure:
                    return False
                if not pointer or type(count) is not int or count <= 0 or samples + count > 24000 * 60:
                    raise ValueError('VOICE_INVALID_WAV')
                pcm = np.ctypeslib.as_array(pointer, shape=(count,)).copy()
                if not np.isfinite(pcm).all():
                    raise ValueError('VOICE_INVALID_WAV')
                samples += count
                callback(pcm)
                return True
            except BaseException as error:
                failed(error); return False
        cancel_cb = CancelCB(cancel); chunk_cb = ChunkCB(chunk)
        params.cancel = cancel_cb
        if callback:
            params.on_chunk = chunk_cb
        audio = Audio(); retired = False; self.native_active = True; self.native_cleanup_complete = False
        try:
            rc = self.lib.qt_synthesize(self.context, C.byref(params), C.byref(audio))
            retired = True
            if failure:
                # -5 confirms cancellation retirement. A native failure cannot
                # be advertised as a successful warm cancellation cleanup.
                if isinstance(failure[0], StreamCancelled) and rc != -5:
                    raise ValueError('STREAM_CLEANUP')
                raise failure[0]
            if rc != 0:
                raise ValueError('QWEN_GGUF_SYNTHESIS')
            if callback:
                if audio.n_samples != 0 or audio.samples:
                    raise ValueError('QWEN_NATIVE_STREAM')
                return None
            if audio.sample_rate != 24000 or audio.channels != 1 or not audio.samples or not 0 < audio.n_samples <= 24000 * 60:
                raise ValueError('VOICE_INVALID_WAV')
            result = np.ctypeslib.as_array(audio.samples, shape=(audio.n_samples,)).copy()
            if not np.isfinite(result).all():
                raise ValueError('VOICE_INVALID_WAV')
            return result
        finally:
            # qt_audio_free is safe for empty/cancelled outputs and runs only
            # after qt_synthesize returned; reference buffers remain cached.
            try:
                self.lib.qt_audio_free(C.byref(audio))
                self.native_cleanup_complete = retired
            finally:
                self.native_active = False

    def write(self, aid, pcm):
        tmp = self.cache / (aid + '.tmp'); path = self.cache / (aid + '.wav')
        try:
            with tmp.open('xb') as stream:
                with wave.open(stream, 'wb') as wav:
                    wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(48000); wav.writeframes(pcm.tobytes())
                stream.flush(); os.fsync(stream.fileno())
            tmp.replace(path)
        finally:
            tmp.unlink(missing_ok=True)
        return path

    def metrics(self, begin, samples, first):
        elapsed = (time.perf_counter()-begin)*1000
        return dict(generationMs=elapsed, firstAudioReadyMs=first, rawDurationMs=samples/24,
                    rawSampleRate=24000, rtf=elapsed/(samples/24), **process_memory())

    def complete(self, text, seed):
        begin = time.perf_counter(); audio = self.invoke(self.params(text, seed))
        raw, pcm = pcm48(audio, 24000)
        return raw, pcm, self.metrics(begin, len(raw), (time.perf_counter()-begin)*1000)

    def prewarm(self, request):
        begin = time.perf_counter(); self.complete('응, 듣고 있어.', 42); self.warmed = True
        return dict(loaded=True, warmed=True, ready=True, prewarmMs=(time.perf_counter()-begin)*1000, promptCacheKey=self.promptKey)

    def synthesize(self, request):
        text = self.validate(request); aid = str(uuid.UUID(request['audioId']))
        if aid != request['audioId']:
            raise ValueError('VOICE_AUDIO_BINDING')
        raw, pcm, metrics = self.complete(text, request['seed']); self.write(aid, pcm)
        if self.raw:
            import soundfile as sf
            sf.write(self.cache/(aid+'.raw.wav'), raw, 24000, subtype='FLOAT')
        return dict(audioId=aid, binding=request['binding'], segmentIndex=request['segmentIndex'], effectiveSeed=request['seed'],
                    durationMs=len(pcm)/48, synthesisStreaming=False, **metrics)

    def stream(self, request, credit):
        import numpy as np
        text = self.validate(request)
        synthesis_id = str(uuid.UUID(request['synthesisId']))
        if request.get('streamVersion') != 1 or self.profile not in ('qwen-gguf', 'qwen-gguf-vulkan') or synthesis_id != request['synthesisId']:
            raise ValueError('QWEN_EXECUTION_PROFILE')
        begin = time.perf_counter(); resampler = IncrementalPcm(24000)
        chunks = total = native = 0; first = None; native_first = None; raw = None
        self.stream_files = []
        def publish(pcm):
            nonlocal chunks, total, first
            for offset in range(0, len(pcm), 48000):
                credit(chunks); part = pcm[offset:offset+48000]
                aid = str(uuid.uuid4()); path = self.write(aid, part); self.stream_files.append(path)
                if first is None:
                    first = (time.perf_counter()-begin)*1000
                emit('audio-chunk', request['requestId'], audioId=aid, binding=request['binding'],
                     segmentIndex=request['segmentIndex'], effectiveSeed=request['seed'], synthesisId=synthesis_id,
                     chunkIndex=chunks, sampleOffset=total, sampleCount=len(part), sampleRate=48000, firstChunkReadyMs=first)
                chunks += 1; total += len(part)
        def on_chunk(pcm):
            nonlocal native, native_first, raw
            credit.checkpoint(chunks, 'native-pcm')
            if native_first is None:
                native_first = (time.perf_counter()-begin)*1000
            native += 1; raw, converted = resampler.push(pcm, False); publish(converted)
        self.invoke(self.params(text, request['seed']), on_chunk, lambda: credit.checkpoint(chunks, 'native-step'))
        credit.checkpoint(chunks, 'native-retired')
        raw, converted = resampler.push(np.zeros(0, dtype=np.float32), True); publish(converted)
        if not chunks:
            raise ValueError('VOICE_INVALID_WAV')
        if self.raw:
            import soundfile as sf
            sf.write(self.cache/(synthesis_id+'.raw.wav'), raw, 24000, subtype='FLOAT')
        return dict(effectiveSeed=request['seed'], synthesisId=synthesis_id, totalSamples=total, totalChunks=chunks,
                    firstChunkReadyMs=first, nativeFirstPcmMs=native_first, nativeChunks=native,
                    synthesisStreaming=True, **self.metrics(begin, len(raw), first))

    def cancel_stream(self):
        if self.native_active or not self.native_cleanup_complete or self.closed or not self.context:
            raise ValueError('STREAM_CLEANUP')
        for path in self.stream_files:
            path.unlink(missing_ok=True)
        self.stream_files = []

    def reuse_audit(self):
        return dict(referenceCacheBuilds=1, promptCacheKey=self.promptKey, nativePid=os.getpid(),
                    nativeCleanupComplete=self.native_cleanup_complete)

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            if self.lib:
                try:
                    self.lib.qt_voice_ref_free(C.byref(self.reference))
                finally:
                    if self.context:
                        self.lib.qt_free(self.context); self.context = None
                self.lib.qt_log_set(LogCB(), None)
        finally:
            for handle in reversed(self.dll_dirs):
                handle.close()
            self.dll_dirs = []


def main():
    worker = None; inbox = None; tails = {}; last_target = None
    def consume_tail(value):
        ident = value.get('requestId')
        if ident not in tails:
            return False
        index, total = tails[ident]
        if value != dict(protocolVersion=1, type='credit', requestId=ident, chunkIndex=index):
            raise ValueError('STREAM_CREDIT')
        if index+1 == total:
            del tails[ident]
        else:
            tails[ident] = (index+1, total)
        return True
    try:
        while True:
            rid = None
            try:
                request = inbox.take() if inbox else read_request(sys.stdin); rid = request['requestId']; kind = request['type']
                with contextlib.redirect_stdout(sys.stderr):
                    if kind == 'credit' and consume_tail(request):
                        continue
                    if kind == 'init' and worker is None:
                        candidate = GgufWorker()
                        try:
                            result = candidate.initialize(request)
                        except BaseException:
                            candidate.close(); raise
                        worker = candidate; inbox = Inbox(sys.stdin)
                        response = 'ready'
                    elif kind == 'health':
                        result = dict(initialized=worker is not None); response = 'ready'
                    elif kind == 'synthesize' and worker:
                        emit('synthesis-started', rid); result = worker.synthesize(request); response = 'audio-ready'
                    elif kind == 'prewarm' and worker:
                        result = worker.prewarm(request); response = 'warmed'
                    elif kind == 'stream' and worker:
                        last_target = stream_target(request); emit('synthesis-started', rid)
                        control = StreamControl(inbox, request, consume_tail)
                        try:
                            result = worker.stream(request, control)
                        except StreamCancelled as cancelled:
                            worker.cancel_stream(); tails.pop(rid, None)
                            emit('cancelled', cancelled.request['requestId'], target=last_target, cleanupComplete=True,
                                 keptWarm=True, boundary=cancelled.boundary, reuseAudit=worker.reuse_audit())
                            continue
                        if control.received < result['totalChunks']:
                            if len(tails) >= 2:
                                raise ValueError('STREAM_CREDIT')
                            tails[rid] = (control.received, result['totalChunks'])
                        response = 'synthesis-finished'
                    elif kind == 'cancel-stream' and worker:
                        if last_target is None or request.get('target') != last_target:
                            raise ValueError('STREAM_CANCEL_BINDING')
                        worker.cancel_stream(); tails.pop(last_target['requestId'], None)
                        result = dict(target=last_target, cleanupComplete=True, keptWarm=True, boundary='terminal', reuseAudit=worker.reuse_audit())
                        response = 'cancelled'
                    elif kind == 'shutdown':
                        if worker:
                            worker.close()
                        emit('cancelled', rid, cleanupComplete=True, keptWarm=False); return
                    else:
                        raise ValueError('QWEN_PROTOCOL')
                emit(response, rid, **result)
            except EOFError:
                return
            except Exception as error:
                code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z_]{1,60}', str(error)) else 'QWEN_GGUF_WORKER_ERROR'
                emit('error', rid, code=code); return
    finally:
        if inbox:
            inbox.close()
        if worker:
            worker.close()


if __name__ == '__main__':
    PROTOCOL = os.fdopen(os.dup(1), 'w', encoding='utf-8', buffering=1)
    os.dup2(2, 1); sys.stdout = sys.stderr
    main()
