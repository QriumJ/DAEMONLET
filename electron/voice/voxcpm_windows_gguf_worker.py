"""Windows application-protocol adapter for the separately admitted Vox GGUF build.

Standard library only; no PyTorch import, auto-download or speaker playback.
"""
import array
import contextlib
import json
import math
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
import uuid
import wave
from control import Inbox, StreamControl, StreamCancelled, stream_target, read_request
from seed_contract import request_seed
from reference_condition import verify_reference_condition
from voxcpm_windows_gguf_runtime import validate, ordinary
from worker import REVISION, SOURCE

PROTOCOL = sys.stdout


def emit(kind, request_id, **data):
    PROTOCOL.write(json.dumps(dict(protocolVersion=1, type=kind, requestId=request_id, **data)) + '\n')
    PROTOCOL.flush()


class WindowsGgufWorker:
    def __init__(self, output=emit):
        self.emit = output
        self.native = None
        self.active = None
        self.stream_files = []
        self.output = queue.Queue(maxsize=4)
        self.closing = threading.Event()
        self.last_end = None
        self.reference_builds = 1
        self.model_kind = 'trained'
        self.conditioning_fingerprint = None

    def _send(self, value):
        if self.native is None or self.native.poll() is not None:
            raise ValueError('STREAM_CLEANUP')
        self.native.stdin.write(json.dumps(value, ensure_ascii=False) + '\n')
        self.native.stdin.flush()

    def _receive(self, timeout=60, checkpoint=None):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if checkpoint:
                checkpoint()
            try:
                value = self.output.get(timeout=min(.02, max(.001, deadline - time.monotonic())))
            except queue.Empty:
                if self.native.poll() is not None:
                    raise ValueError('STREAM_CLEANUP')
                continue
            if isinstance(value, Exception):
                raise value
            return value
        raise ValueError('STREAM_CLEANUP')

    def initialize(self, request):
        started = time.perf_counter()
        assets = validate(request)
        validated = time.perf_counter()
        self.cache = Path(request['cache'])
        self.cache.mkdir(parents=True, exist_ok=True)
        if self.cache.is_symlink() or getattr(self.cache.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('LINK')
        self.cache = ordinary(self.cache, True)
        self.profile, self.session = request['executionProfile'], request['runtimeSessionId']
        self.selected = assets['selected']
        self.model_kind = assets['modelKind']
        self.reference_builds = assets['referenceCacheBuilds']
        self.conditioning_fingerprint = assets['conditioningFingerprint']
        reference = assets['reference']
        if self.model_kind == 'public-base' and reference is not None:
            # A fresh UUID subdirectory prevents a preexisting mutable cache WAV
            # from replacing the reference after its managed source is checked.
            snapshot_dir = self.cache / ('reference-' + str(uuid.uuid4()))
            snapshot_dir.mkdir()
            self.reference_snapshot = snapshot_dir
            reference = verify_reference_condition(request['conditioning'], snapshot_dir)['path']
        environment = {k: v for k, v in os.environ.items()
                       if not k.startswith(('GGML_', 'LLAMA_', 'DYLD_', 'LD_'))}
        # Only existing toolkit files; no registry or global PATH modifications.
        cuda = Path(os.environ.get('CUDA_PATH', 'C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v13.0'))
        if assets['backend'] == 'CUDA':
            directories = [p for p in [cuda / 'bin/x64', cuda / 'bin'] if p.is_dir()]
            if not directories:
                raise ValueError('RUNTIME_DEPENDENCY')
            environment['PATH'] = os.pathsep.join([str(assets['runtime']), *(str(p) for p in directories),
                                                  os.environ.get('PATH', '')])
        else:
            # Use the installed vendor Vulkan driver, without inherited custom
            # ICDs, optional developer layers or user ggml device-index overrides.
            for key in ('GGML_VK_VISIBLE_DEVICES', 'VK_ICD_FILENAMES', 'VK_DRIVER_FILES', 'VK_ADD_DRIVER_FILES',
                        'VK_INSTANCE_LAYERS', 'VK_LAYER_PATH', 'VK_ADD_LAYER_PATH', 'VK_IMPLICIT_LAYER_PATH',
                        'VK_ADD_IMPLICIT_LAYER_PATH', 'VK_LOADER_LAYERS_ENABLE', 'VK_LOADER_LAYERS_ALLOW'):
                environment.pop(key, None)
            environment['VK_LOADER_LAYERS_DISABLE'] = '~all~'
        arguments = [str(assets[k]) for k in ['binary', 'base', 'acoustic']]
        if reference is not None:
            arguments.extend([str(reference), self.selected['referenceSha256']])
        self.native = subprocess.Popen(arguments,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, encoding='utf-8', errors='strict', bufsize=1, env=environment,
                                       cwd=str(assets['runtime']), creationflags=subprocess.CREATE_NO_WINDOW)
        self.native_log = ''

        def logs():
            try:
                for line in self.native.stderr:
                    self.native_log = (self.native_log + line)[-131072:]
            except (OSError, UnicodeError):
                pass

        def reader():
            try:
                while not self.closing.is_set():
                    line = self.native.stdout.readline(2_000_001)
                    if not line or len(line) > 2_000_000 or not line.endswith('\n'):
                        raise ValueError('PROTOCOL_LIMIT')
                    value = json.loads(line)
                    if not isinstance(value, dict):
                        raise ValueError('PROTOCOL_VERSION')
                    while not self.closing.is_set():
                        try:
                            self.output.put(value, timeout=.1)
                            break
                        except queue.Full:
                            pass
            except Exception as error:
                if not self.closing.is_set():
                    try:
                        self.output.put(error, timeout=.2)
                    except queue.Full:
                        pass

        threading.Thread(target=logs, daemon=True).start()
        threading.Thread(target=reader, daemon=True).start()
        ready = self._receive(timeout=120)
        if ready.get('type') == 'error':
            raise ValueError('VOX_GGUF_NATIVE_INIT')
        if ready.get('seedContract') != 1:
            raise ValueError('VOICE_SEED_UNSUPPORTED')
        components = ready.get('componentBackends')
        if (ready.get('type') != 'ready' or ready.get('backend') != assets['backend']
                or type(ready.get('pid')) is not int or ready['pid'] != self.native.pid
                or type(ready.get('referenceCacheBuilds')) is not int
                or ready['referenceCacheBuilds'] != self.reference_builds
                or (self.model_kind == 'public-base' and ready.get('referenceMode') !=
                    ('base' if assets['mode'] == 'base' else 'reference'))
                or type(ready.get('offloadedLayers')) is not int or ready['offloadedLayers'] != 29
                or type(ready.get('totalLayers')) is not int or ready['totalLayers'] != 29 or not isinstance(components, dict)
                or set(components) != {'ResidualLM', 'LocEnc', 'LocDiT', 'FSQ', 'AudioVAE', 'Projections', 'StopPredictor'}
                or not all(v == assets['backend'] + '0' for v in components.values())):
            raise ValueError('UNSUPPORTED_DEVICE')
        self.audit = dict(seedContract=1, workerPid=os.getpid(), nativePid=self.native.pid,
                          loadMs=(time.perf_counter() - started) * 1000,
                          assetValidationMs=(validated - started) * 1000,
                          modelLoadMs=ready['modelLoadMs'], referenceMs=ready['referenceMs'],
                          executionProfile=self.profile, backend=components['ResidualLM'], backendFamily=assets['backend'],
                          componentBackends=components, offloadedLayers=29, dtype='float16-weights',
                          packageSha256=self.selected['packageSha256'],
                          adapterSha256=self.selected['adapterSha256'], modelRevision=REVISION,
                          sourceCommit=SOURCE, nativeSourceCommit=assets['policy']['sourceCommit'],
                          referenceSha256=self.selected['referenceSha256'],
                          adapterRepresentation='merged-once-fp32-then-f16', mergedKeys=384, mergedMatrices=192,
                          missingKeys=0, skippedKeys=0, referenceCacheBuilds=self.reference_builds, compileCounts={},
                          runtimeFingerprint=assets['runtimeFingerprint'],
                          derivativeManifestSha256=assets['derivativeManifestSha256'],
                          originalModelVerification=assets['originalModelVerification'], ggufVerification='full-sha256',
                          capabilities=dict(engine='voxcpm2', synthesisStreaming=True,
                                            cancellation='cooperative-stream-with-owned-process-fallback',
                                            warmCancellationReuse=True))
        if self.model_kind == 'public-base':
            self.audit.update(ggufModelKind='public-base', mode=assets['mode'], referenceMode=assets['mode'],
                              modelRepository=assets['modelRepository'], modelRevision=assets['modelRevision'],
                              modelFiles=assets['modelFiles'], publisher=assets['publisher'],
                              managedModelReceiptVerified=assets['managedModelReceiptVerified'],
                              sourceCommit=assets['policy']['sourceCommit'], adapterRepresentation='none',
                              mergedKeys=0, mergedMatrices=0, referenceContract=1,
                              conditioningFingerprint=self.conditioning_fingerprint, defaultVoice=assets['defaultVoice'])
        return self.audit

    def _input(self, request):
        seed = request_seed(request)
        text = request.get('text')
        binding = request.get('binding')
        if (not isinstance(text, str) or not text.strip() or len(text) > 400
                or len(text.encode('utf-8')) > 1600 or request.get('style') is not None
                or not isinstance(binding, dict) or binding.get('runtimeSessionId') != self.session):
            raise ValueError('SYNTHESIS_INPUT')
        if self.model_kind == 'public-base' and binding.get('conditioningFingerprint') != self.conditioning_fingerprint:
            raise ValueError('VOICE_REFERENCE_BINDING')
        return text, seed

    def _write(self, audio_id, pcm):
        if str(uuid.UUID(audio_id)) != audio_id:
            raise ValueError('VOICE_AUDIO_BINDING')
        path = self.cache / (audio_id + '.wav')
        temporary = self.cache / (audio_id + '.partial')
        self.stream_files.extend([temporary, path])
        samples = array.array('h', (int(max(-1, min(1, x)) * 32767) for x in pcm))
        if sys.byteorder != 'little':
            samples.byteswap()
        with wave.open(str(temporary), 'wb') as output:
            output.setnchannels(1); output.setsampwidth(2); output.setframerate(48000)
            output.writeframes(samples.tobytes())
        temporary.replace(path)

    def _chunks(self, text, seed, ident, checkpoint):
        self.active = ident
        self.stream_files = []
        self._send(dict(type='generate', id=ident, text=text, seed=seed))
        index = offset = 0
        while True:
            if index:
                self._send(dict(type='credit', id=ident, index=index - 1))
            row = self._receive(checkpoint=checkpoint)
            if row.get('id') != ident or row.get('effectiveSeed') != seed:
                raise ValueError('STREAM_CANCEL_BINDING')
            if row.get('type') == 'end':
                if (row.get('error') or row.get('cancelled') or row.get('cleanupComplete') is not True
                        or type(row.get('samples')) is not int or row['samples'] != offset
                        or type(row.get('referenceCacheBuilds')) is not int
                        or row['referenceCacheBuilds'] != self.reference_builds
                        or type(row.get('pid')) is not int or row['pid'] != self.native.pid):
                    raise ValueError('STREAM_CLEANUP')
                self.last_end = row
                self.active = None
                checkpoint()
                return
            pcm = row.get('pcm')
            if (row.get('type') != 'chunk' or type(row.get('index')) is not int or row['index'] != index
                    or type(row.get('offset')) is not int or row['offset'] != offset
                    or not isinstance(pcm, list) or not 0 < len(pcm) <= 48000 or offset + len(pcm) > 48000 * 60
                    or not all(type(value) in (int, float) and math.isfinite(value) for value in pcm)):
                raise ValueError('INVALID_WAVEFORM')
            index += 1; offset += len(pcm)
            yield pcm

    def stream(self, request, credit):
        text, seed = self._input(request)
        if request.get('streamVersion') != 1 or not isinstance(request.get('synthesisId'), str):
            raise ValueError('SYNTHESIS_INPUT')
        started = time.perf_counter(); total = chunks = 0; first = first_signal = None; peak = blocked = 0

        def checkpoint():
            credit.checkpoint(chunks)

        with contextlib.closing(self._chunks(text, seed, request['synthesisId'], checkpoint)) as parts:
            for pcm in parts:
                wait = time.perf_counter(); credit(chunks); blocked += (time.perf_counter() - wait) * 1000
                magnitude = max(map(abs, pcm)); peak = max(peak, magnitude)
                audio_id = str(uuid.uuid4()); self._write(audio_id, pcm)
                if first is None:
                    first = (time.perf_counter() - started) * 1000
                if first_signal is None and magnitude >= .01:
                    first_signal = (time.perf_counter() - started) * 1000
                self.emit('audio-chunk', request['requestId'], effectiveSeed=seed, audioId=audio_id,
                          binding=request['binding'], synthesisId=request['synthesisId'],
                          segmentIndex=request['segmentIndex'], chunkIndex=chunks, sampleOffset=total,
                          sampleCount=len(pcm), sampleRate=48000, firstChunkReadyMs=first,
                          firstSignalChunkReadyMs=first_signal)
                total += len(pcm); chunks += 1
        if not total or peak < 1e-7:
            raise ValueError('INVALID_WAVEFORM')
        elapsed = (time.perf_counter() - started) * 1000
        return dict(effectiveSeed=seed, synthesisId=request['synthesisId'], totalSamples=total, totalChunks=chunks,
                    firstChunkReadyMs=first, firstSignalChunkReadyMs=first_signal,
                    generationMs=elapsed, producerBlockedMs=blocked,
                    rtf=elapsed / (total / 48), **self.reuse_audit())

    def synthesize(self, request):
        text, seed = self._input(request)
        started = time.perf_counter(); pcm = []; first_native = None
        ident = str(uuid.uuid4())
        with contextlib.closing(self._chunks(text, seed, ident, lambda: None)) as parts:
            for part in parts:
                if first_native is None:
                    first_native = (time.perf_counter() - started) * 1000
                pcm.extend(part)
        if not pcm or max(map(abs, pcm)) < 1e-7:
            raise ValueError('INVALID_WAVEFORM')
        self._write(request['audioId'], pcm)
        elapsed = (time.perf_counter() - started) * 1000
        return dict(audioId=request['audioId'], binding=request['binding'], segmentIndex=request['segmentIndex'],
                    effectiveSeed=seed, durationMs=len(pcm) / 48, generationMs=elapsed,
                    firstAudioReadyMs=elapsed, firstNativeChunkReadyMs=first_native,
                    rtf=elapsed / (len(pcm) / 48), **self.reuse_audit())

    def cancel_stream(self):
        if self.active:
            ident = self.active; self._send(dict(type='cancel', id=ident))
            deadline = time.monotonic() + 1.2
            while time.monotonic() < deadline:
                row = self._receive(timeout=max(.001, deadline - time.monotonic()))
                if row.get('id') != ident:
                    raise ValueError('STREAM_CANCEL_BINDING')
                if row.get('type') == 'end':
                    # Native completion may race the target-bound cancel request.
                    # Both completed and cancelled clean terminal states are safe
                    # to retain after their exact target has been checked.
                    if (row.get('cleanupComplete') is not True or type(row.get('cancelled')) is not bool
                            or row.get('error') or type(row.get('referenceCacheBuilds')) is not int
                            or row['referenceCacheBuilds'] != self.reference_builds
                            or type(row.get('pid')) is not int or row['pid'] != self.native.pid):
                        raise ValueError('STREAM_CLEANUP')
                    self.last_end = row; self.active = None; break
            if self.active:
                raise ValueError('STREAM_CLEANUP')
        for path in self.stream_files:
            path.unlink(missing_ok=True)
        self.stream_files = []

    def reuse_audit(self):
        if self.native is None or self.native.poll() is not None:
            raise ValueError('STREAM_CLEANUP')
        if self.last_end is not None and (type(self.last_end.get('referenceCacheBuilds')) is not int
                                         or self.last_end['referenceCacheBuilds'] != self.reference_builds):
            raise ValueError('VOICE_REFERENCE_RUNTIME')
        return dict(nativePid=self.native.pid, referenceCacheBuilds=self.reference_builds, compileCounts={})

    def close(self):
        child = self.native
        if child is None:
            self._remove_reference_snapshot()
            return
        try:
            if child.poll() is None:
                self._send(dict(type='quit')); child.wait(timeout=.7)
        except Exception:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=.3)
                except subprocess.TimeoutExpired:
                    child.kill(); child.wait(timeout=.3)
        finally:
            self.closing.set()
            if child.stdin:
                try:
                    child.stdin.close()
                except OSError:
                    pass
            self._remove_reference_snapshot()

    def _remove_reference_snapshot(self):
        directory = getattr(self, 'reference_snapshot', None)
        if directory:
            (directory / 'reference.wav').unlink(missing_ok=True)
            directory.rmdir()
            self.reference_snapshot = None


def main():
    worker = inbox = last_target = None
    tails = {}

    def tail(value):
        key = value.get('requestId')
        if key not in tails:
            return False
        index, total = tails[key]
        if value != dict(protocolVersion=1, type='credit', requestId=key, chunkIndex=index):
            raise ValueError('STREAM_CREDIT')
        if index + 1 == total:
            del tails[key]
        else:
            tails[key] = (index + 1, total)
        return True

    try:
        while True:
            request_id = None
            try:
                request = inbox.take() if inbox else read_request(sys.stdin)
                request_id = request['requestId']; kind = request['type']
                if kind == 'credit' and tail(request):
                    continue
                if kind == 'init' and worker is None:
                    candidate = WindowsGgufWorker()
                    try:
                        audit = candidate.initialize(request)
                    except BaseException:
                        candidate.close(); raise
                    worker = candidate; inbox = Inbox(sys.stdin); emit('ready', request_id, **audit)
                elif kind == 'health':
                    emit('ready', request_id, initialized=worker is not None)
                elif kind == 'synthesize' and worker:
                    emit('synthesis-started', request_id)
                    emit('audio-ready', request_id, **worker.synthesize(request))
                elif kind == 'stream' and worker:
                    last_target = stream_target(request); emit('synthesis-started', request_id)
                    control = StreamControl(inbox, request, tail)
                    try:
                        result = worker.stream(request, control)
                    except StreamCancelled as cancelled:
                        worker.cancel_stream(); tails.pop(request_id, None)
                        emit('cancelled', cancelled.request['requestId'], target=last_target,
                             cleanupComplete=True, keptWarm=True, boundary=cancelled.boundary,
                             reuseAudit=worker.reuse_audit())
                        continue
                    if control.received < result['totalChunks']:
                        if len(tails) >= 2:
                            raise ValueError('STREAM_CREDIT')
                        tails[request_id] = (control.received, result['totalChunks'])
                    emit('synthesis-finished', request_id, **result)
                elif kind == 'cancel-stream' and worker:
                    if last_target is None or request.get('target') != last_target:
                        raise ValueError('STREAM_CANCEL_BINDING')
                    worker.cancel_stream(); tails.pop(last_target['requestId'], None)
                    emit('cancelled', request_id, target=last_target, cleanupComplete=True, keptWarm=True,
                         boundary='terminal', reuseAudit=worker.reuse_audit())
                elif kind == 'shutdown':
                    if worker:
                        worker.close(); worker = None
                    emit('cancelled', request_id); return
                else:
                    raise ValueError('PROTOCOL_STATE')
            except EOFError:
                return
            except Exception as error:
                code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z_]{1,60}', str(error)) else 'VOX_GGUF_WORKER_ERROR'
                emit('error', request_id, code=code); return
    finally:
        if inbox:
            inbox.close()
        if worker:
            worker.close()


if __name__ == '__main__':
    PROTOCOL = os.fdopen(os.dup(1), 'w', encoding='utf-8', buffering=1)
    os.dup2(2, 1); sys.stdout = sys.stderr
    main()
