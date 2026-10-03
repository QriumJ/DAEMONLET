"""CPU tests with fake native calls. Never load a DLL, model, Torch or GPU.

PCM tests use the already installed numpy/scipy dependencies. On a host without
them the standard-library ABI/admission/binding tests still run explicitly.
"""
from collections import deque
import ctypes as C
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'electron/voice'))
import qwen_gguf_worker as worker
from qwen_gguf_abi import Init, Params, Audio, Ref, verify_layout, bind_devices
from control import StreamControl, StreamCancelled, stream_target

try:
    import numpy as np
    import scipy
    HAVE_PCM = True
except ImportError:
    HAVE_PCM = False


class Admission(unittest.TestCase):
    def test_device_exports_bind_from_distinct_defining_libraries(self):
        class Function:
            def __init__(self,result): self.result=result
            def __call__(self,*_): return self.result
        class Library:
            def __init__(self,exports): self.exports=exports
            def __getattr__(self,name):
                if name not in self.exports: raise AttributeError(name)
                return self.exports[name]
        registry=Library({'ggml_backend_dev_by_name':Function(123)})
        base=Library({name:Function(value) for name,value in [('ggml_backend_dev_name',b'Vulkan0'),
                        ('ggml_backend_dev_description',b'NVIDIA GeForce RTX 4090'),('ggml_backend_dev_type',1),('ggml_backend_dev_memory',None)]})
        bound=bind_devices(registry,base)
        self.assertIs(bound.ggml_backend_dev_by_name,registry.exports['ggml_backend_dev_by_name'])
        self.assertIs(bound.ggml_backend_dev_name,base.exports['ggml_backend_dev_name'])
        self.assertEqual(bound.ggml_backend_dev_type.restype,C.c_int)
        self.assertEqual(bound.ggml_backend_dev_by_name(b'Vulkan0'),123)
        self.assertEqual(bound._libraries,(registry,base))
        with self.assertRaises(AttributeError): bind_devices(registry,registry)

    def test_abi_probe_layout_and_wrong_version(self):
        verify_layout(worker.POLICY['abiLayout'])
        invalid = json.loads(json.dumps(worker.POLICY['abiLayout']))
        invalid['Params']['offsets']['cancel'] += 8
        with self.assertRaisesRegex(ValueError, 'QWEN_GGUF_ABI'):
            verify_layout(invalid)
        invalid = json.loads(json.dumps(worker.POLICY['abiLayout']))
        invalid['Audio']['size'] += 8
        with self.assertRaisesRegex(ValueError, 'QWEN_GGUF_ABI'):
            verify_layout(invalid)

    def test_identity_distinguishes_native_build_reference_mode_and_transcript(self):
        combinations = [('a', 'one', 'icl'), ('b', 'one', 'icl'), ('a', 'two', 'icl'), ('a', 'one', 'x-vector')]
        keys = {worker.prompt_key(*value) for value in combinations}
        changed = dict(worker.POLICY, sourceCommit='new-unreviewed-build')
        with patch.object(worker, 'POLICY', changed):
            keys.add(worker.prompt_key(*combinations[0]))
        self.assertEqual(len(keys), 5)

    def test_native_hash_corruption_and_extra_backend_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); target = root / 'qwen.dll'; target.write_bytes(b'reviewed')
            binaries = {'qwen.dll': dict(bytes=8, sha256=hashlib.sha256(b'reviewed').hexdigest())}
            policy = dict(worker.POLICY, backends=dict(worker.POLICY['backends'], cuda=dict(worker.POLICY['backends']['cuda'], binaries=binaries)))
            with patch.object(worker, 'POLICY', policy):
                worker.verify_native(root)
                target.write_bytes(b'changed!')
                with self.assertRaisesRegex(ValueError, 'QWEN_GGUF_RUNTIME_CHANGED'):
                    worker.verify_native(root)
                target.write_bytes(b'reviewed'); (root / 'ggml-cuda-other.dll').write_bytes(b'not-reviewed')
                with self.assertRaisesRegex(ValueError, 'QWEN_GGUF_RUNTIME_CHANGED'):
                    worker.verify_native(root)

    def test_backend_family_hashes_cannot_be_interchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); target = root / 'qwen.dll'; target.write_bytes(b'cuda')
            make = lambda data: {'qwen.dll': dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())}
            backends = {'cuda':dict(device='CUDA0',backend='cuda:0',binaries=make(b'cuda')),
                        'vulkan':dict(device='Vulkan0',backend='vulkan:0',binaries=make(b'vulkan'))}
            with patch.object(worker, 'POLICY', dict(worker.POLICY,backends=backends)):
                worker.verify_native(root, 'qwen-gguf')
                with self.assertRaisesRegex(ValueError, 'QWEN_GGUF_RUNTIME_CHANGED'):
                    worker.verify_native(root, 'qwen-gguf-vulkan')
                target.write_bytes(b'vulkan'); worker.verify_native(root, 'qwen-gguf-vulkan')
                with self.assertRaisesRegex(ValueError, 'QWEN_GGUF_RUNTIME_CHANGED'):
                    worker.verify_native(root, 'qwen-gguf')

    def test_adjacent_executable_is_not_part_of_dll_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); (root/'qwen.dll').write_bytes(b'pinned')
            (root/'test-abi-c.exe').write_bytes(b'not loaded or launched by the worker')
            pins = {'qwen.dll':dict(bytes=6,sha256=hashlib.sha256(b'pinned').hexdigest())}
            policy = dict(worker.POLICY,backends=dict(worker.POLICY['backends'],vulkan=dict(worker.POLICY['backends']['vulkan'],binaries=pins)))
            with patch.object(worker,'POLICY',policy),patch.object(worker.C,'CDLL',side_effect=AssertionError('admission executed software')):
                worker.verify_native(root,'qwen-gguf-vulkan')
                (root/'ggml-vulkan-extra.dll').write_bytes(b'unreviewed backend')
                with self.assertRaisesRegex(ValueError,'QWEN_GGUF_RUNTIME_CHANGED'):
                    worker.verify_native(root,'qwen-gguf-vulkan')

    def test_unapproved_backend_refuses_before_reference_or_native_calls(self):
        backends = dict(worker.POLICY['backends'], vulkan=dict(device='Vulkan0',backend='vulkan:0',binaries=None))
        with patch.object(worker, 'POLICY', dict(worker.POLICY,backends=backends)), \
             patch.object(worker.C, 'CDLL', side_effect=AssertionError('unapproved library was loaded')), \
             patch.object(worker, 'verify_reference_condition', side_effect=AssertionError('reference was read')):
            with self.assertRaisesRegex(ValueError, 'QWEN_GGUF_BACKEND_UNAPPROVED'):
                worker.GgufWorker().initialize(dict(engine=worker.ENGINE,executionProfile='qwen-gguf-vulkan'))

    def test_capability_and_prompt_identity_distinguish_gpu_backend(self):
        vulkan = dict(device='Vulkan0',backend='vulkan:0',binaries=worker.POLICY['binaries'])
        with patch.object(worker, 'POLICY', dict(worker.POLICY,backends=dict(worker.POLICY['backends'],vulkan=vulkan))):
            self.assertEqual(worker.capabilities_for('qwen-gguf-vulkan')['backend'], 'vulkan:0')
            self.assertEqual(worker.capabilities_for('qwen-gguf-vulkan-complete')['backendDevice'], 'Vulkan0')
            self.assertNotEqual(worker.prompt_key('reference','text','icl','qwen-gguf'),
                                worker.prompt_key('reference','text','icl','qwen-gguf-vulkan'))

    def test_actual_device_name_and_type_are_verified(self):
        class Devices:
            name = b'Vulkan0'; kind = 1; description = b'NVIDIA GeForce RTX 4090'
            def ggml_backend_dev_by_name(self, _): return 123
            def ggml_backend_dev_name(self, _): return self.name
            def ggml_backend_dev_type(self, _): return self.kind
            def ggml_backend_dev_description(self, _): return self.description
            def ggml_backend_dev_memory(self, _, free, total):
                C.cast(free,C.POINTER(C.c_size_t)).contents.value=1234
                C.cast(total,C.POINTER(C.c_size_t)).contents.value=5678
        selected = dict(device='Vulkan0'); devices = Devices()
        audit = worker.inspect_device(devices,selected)
        self.assertEqual(audit['gpuDeviceName'],'NVIDIA GeForce RTX 4090'); self.assertEqual(audit['gpuFreeBytes'],1234)
        self.assertTrue(audit['cpuOperatorFallback'])
        for name, kind, description in [(b'Vulkan0',0,b'CPU renamed'), (b'CUDA0',1,b'wrong family'), (b'Vulkan0',1,None)]:
            devices.name,devices.kind,devices.description=name,kind,description
            with self.subTest(name=name,kind=kind), self.assertRaisesRegex(ValueError,'QWEN_GGUF_GPU_REQUIRED'):
                worker.inspect_device(devices,selected)

    def test_backend_environment_cannot_force_software_vulkan_or_external_plugins(self):
        inherited = dict(GGML_BACKEND='CPU',GGML_BACKEND_PATH='unreviewed.dll',GGML_VK_VISIBLE_DEVICES='99',
                         VK_DRIVER_FILES='software-cpu.json',VK_INSTANCE_LAYERS='unreviewed-layer')
        with patch.dict(worker.os.environ,inherited,clear=True):
            worker.configure_backend_environment(dict(device='Vulkan0'))
            self.assertEqual(worker.os.environ['GGML_BACKEND'],'Vulkan0')
            self.assertNotIn('GGML_BACKEND_PATH',worker.os.environ); self.assertNotIn('GGML_VK_VISIBLE_DEVICES',worker.os.environ)
            self.assertNotIn('VK_DRIVER_FILES',worker.os.environ); self.assertNotIn('VK_INSTANCE_LAYERS',worker.os.environ)
            self.assertEqual(worker.os.environ['VK_LOADER_LAYERS_DISABLE'],'~all~')

    def test_symlink_native_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); file = root / 'actual.dll'; file.write_bytes(b'x')
            try:
                (root / 'qwen.dll').symlink_to(file)
            except OSError:
                self.skipTest('host does not permit symlink creation')
            with self.assertRaisesRegex(ValueError, 'QWEN_GGUF_ASSET_CHANGED'):
                worker.sha(root / 'qwen.dll')

    def test_capability_does_not_claim_transport_chunking(self):
        self.assertTrue(worker.CAPABILITIES['synthesisStreaming'])
        self.assertFalse(worker.CAPABILITIES['transportChunking'])
        self.assertEqual(worker.CAPABILITIES['backend'], 'cuda:0')
        self.assertEqual(worker.CAPABILITIES['cancellation'], 'cooperative-with-process-fallback')
        self.assertEqual(worker.POLICY['modelType'], 'base')
        self.assertEqual(sum(item['bytes'] for item in worker.POLICY['models'].values()), 1283766112)

    def test_environment_rejects_mac_before_dependency_imports(self):
        with patch.object(worker.sys, 'platform', 'darwin'), patch.object(worker.metadata, 'version', side_effect=AssertionError('dependency lookup')):
            with self.assertRaisesRegex(ValueError, 'QWEN_GGUF_PLATFORM_REQUIRED'):
                worker.verify_environment()

    def test_exact_dependency_version_is_required_without_loading_gpu_packages(self):
        with patch.object(worker.sys, 'platform', 'win32'), patch.object(worker.sys, 'prefix', 'owned-venv'), \
             patch.object(worker.sys, 'base_prefix', 'base'), patch.object(worker.platform, 'machine', lambda:'AMD64'), \
             patch.object(worker.platform, 'python_version', lambda:worker.POLICY['python']), \
             patch.object(worker.metadata, 'version', lambda name:worker.POLICY['dependencies'][name]):
            worker.verify_environment()
            with patch.object(worker.metadata, 'version', lambda _:'unreviewed'), self.assertRaisesRegex(ValueError, 'QWEN_GGUF_RUNTIME_VERSION'):
                worker.verify_environment()
        self.assertNotIn('torch', sys.modules)

    def test_binding_rejects_before_inference(self):
        owned = worker.GgufWorker(); owned.session = str(uuid.uuid4()); owned.profile = 'qwen-gguf'; owned.conditioning = {'fingerprint': 'reference'}
        valid = dict(binding=dict(runtimeSessionId=owned.session, conditioningFingerprint='reference', engine=worker.ENGINE,
                                  executionProfile=owned.profile, speechEpoch=1, effectiveSeed=42), seed=42, text='안녕.', segmentIndex=0)
        self.assertEqual(owned.validate(valid), '안녕.')
        for field, value, code in [('runtimeSessionId', 'foreign', 'VOICE_SESSION'), ('conditioningFingerprint', 'foreign', 'VOICE_REFERENCE_BINDING'),
                                   ('engine', 'qwen3-tts-06b', 'QWEN_EXECUTION_PROFILE'), ('executionProfile', 'qwen-complete', 'QWEN_EXECUTION_PROFILE'),
                                   ('speechEpoch', True, 'VOICE_AUDIO_BINDING'), ('effectiveSeed', 43, 'VOICE_SEED_MISMATCH')]:
            altered = dict(valid, binding=dict(valid['binding'], **{field: value}))
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, code):
                owned.validate(altered)
        for seed in (True, 0, -1, 2147483648, 4.2):
            altered = dict(valid, seed=seed, binding=dict(valid['binding'], effectiveSeed=seed))
            with self.subTest(seed=seed), self.assertRaisesRegex(ValueError, 'VOICE_SEED_INVALID'):
                owned.validate(altered)
        for text in ('', 'a'*601, 'bad\x00text'):
            with self.subTest(text=text[:8]), self.assertRaisesRegex(ValueError, 'VOICE_MESSAGE'):
                owned.validate(dict(valid, text=text))


class FakeLib:
    """Execute callbacks on a native-style owner thread and preserve buffers."""
    def __init__(self, frames=8):
        self.frames = frames; self.freed = 0; self.calls = []; self.fail_retirement = False
        self.bad_pcm = False; self.abort_entry = False; self.active = False; self.ended = False
        self.complete_audio = np.sin(np.arange(1920*self.frames, dtype=np.float32)/45)*.1

    def qt_tts_default_params(self, pointer):
        C.cast(pointer, C.POINTER(Params)).contents.abi_version = 5

    def qt_synthesize(self, _, params_pointer, audio_pointer):
        params = C.cast(params_pointer, C.POINTER(Params)).contents
        self.calls.append(dict(seed=params.seed, refText=params.ref_text, refCodes=bool(params.ref_codes), refSamples=params.ref_n_samples))
        self.active = True; self.ended = False
        if self.abort_entry:
            raise OSError('native entry did not return')
        rc = [0]
        def native():
            if params.on_chunk:
                for index in range(self.frames):
                    if params.cancel(None):
                        rc[0] = -5; break
                    pcm = self.complete_audio[index*1920:(index+1)*1920].copy()
                    if self.bad_pcm:
                        pcm[0] = np.nan
                    if not params.on_chunk(pcm.ctypes.data_as(C.POINTER(C.c_float)), pcm.size, None):
                        rc[0] = -5; break
            else:
                self.output = self.complete_audio.copy()
                audio = C.cast(audio_pointer, C.POINTER(Audio)).contents
                audio.samples = self.output.ctypes.data_as(C.POINTER(C.c_float)); audio.n_samples = len(self.output)
                audio.sample_rate = 24000; audio.channels = 1
            self.active = False; self.ended = True
        owner = threading.Thread(target=native); owner.start(); owner.join(5)
        if owner.is_alive():
            raise AssertionError('callback deadlock')
        return -3 if self.fail_retirement else rc[0]

    def qt_audio_free(self, _):
        if self.active:
            # A failed native entry is not a successful retirement even if its
            # empty output can be released without crossing the native ABI.
            self.freed += 1; return
        assert self.ended
        self.freed += 1

    def qt_voice_ref_free(self, _):
        pass

    def qt_free(self, _):
        pass

    def qt_log_set(self, *_):
        pass


class Queue:
    def __init__(self):
        self.items = deque(); self.on_wait = None
    def peek(self, wait=False):
        if not self.items and wait and self.on_wait:
            self.on_wait()
        if not self.items:
            if wait:
                raise AssertionError('unexpected credit wait')
            return None
        return self.items[0]
    def take(self):
        return self.items.popleft()


@unittest.skipUnless(HAVE_PCM, 'numpy/scipy are required for fake-native PCM tests')
class NativeStream(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.owned = worker.GgufWorker(); self.owned.lib = FakeLib(); self.owned.context = 123
        self.owned.session = str(uuid.uuid4()); self.owned.cache = Path(self.temp.name).resolve(); self.owned.profile = 'qwen-gguf'
        self.owned.mode = 'x-vector'; self.owned.transcript = ''; self.owned.raw = False; self.owned.promptKey = 'prompt'
        self.owned.conditioning = {'fingerprint': 'reference'}
        self.embedding = (C.c_float*1024)(); self.codes = (C.c_int32*64)()
        self.owned.reference = Ref(self.embedding, 1024, self.codes, 4, 16)
        self.request = dict(protocolVersion=1, type='stream', requestId='request', synthesisId=str(uuid.uuid4()), streamVersion=1,
                            binding=dict(runtimeSessionId=self.owned.session, conditioningFingerprint='reference', engine=worker.ENGINE,
                                         executionProfile=self.owned.profile, speechEpoch=1, effectiveSeed=42), seed=42, text='안녕.', segmentIndex=0)
        self.queue = Queue(); self.control = StreamControl(self.queue, self.request, lambda _:False)
        self.events = []
    def publish(self, kind, rid, **fields):
        self.events.append(dict(type=kind, requestId=rid, **fields))
        self.queue.items.append(dict(protocolVersion=1, type='credit', requestId=rid, chunkIndex=fields['chunkIndex']))
    def cancel(self):
        self.queue.items.append(dict(protocolVersion=1, type='cancel-stream', requestId='cancel', target=stream_target(self.request)))

    def test_native_chunks_pcm_offsets_seed_and_immutable_reference(self):
        with patch.object(worker, 'emit', self.publish):
            result = self.owned.stream(self.request, self.control)
        self.assertEqual(result['nativeChunks'], 8); self.assertEqual(result['totalSamples'], 8*1920*2)
        self.assertTrue(self.owned.native_cleanup_complete); self.assertEqual(self.owned.lib.freed, 1)
        offset = 0; assembled = []
        for index, event in enumerate(self.events):
            self.assertEqual(event['chunkIndex'], index); self.assertEqual(event['sampleOffset'], offset)
            self.assertEqual(event['binding'], self.request['binding']); self.assertEqual(event['effectiveSeed'], 42)
            with wave.open(str(self.owned.cache/(event['audioId']+'.wav')), 'rb') as wav:
                self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getsampwidth()), (48000, 1, 2))
                assembled.append(np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').copy())
                self.assertEqual(wav.getnframes(), event['sampleCount'])
            offset += event['sampleCount']
        _, expected = worker.pcm48(self.owned.lib.complete_audio, 24000)
        np.testing.assert_array_equal(np.concatenate(assembled), expected)
        self.assertEqual(self.owned.lib.calls, [dict(seed=42, refText=None, refCodes=False, refSamples=0)])
        self.assertFalse(list(self.owned.cache.glob('*.tmp')))

    def test_icl_passes_cached_codes_and_transcript_without_raw_reference(self):
        self.owned.mode = 'icl'; self.owned.transcript = '기준 문장.'
        self.owned.complete('안녕.', 42)
        self.assertEqual(self.owned.lib.calls[0], dict(seed=42, refText='기준 문장.'.encode(), refCodes=True, refSamples=0))

    def test_cancel_waits_native_retirement_frees_then_recovers_same_context(self):
        def first_chunk(kind, rid, **fields):
            self.events.append(fields); self.cancel()
        with patch.object(worker, 'emit', first_chunk), self.assertRaises(StreamCancelled):
            self.owned.stream(self.request, self.control)
        self.assertTrue(self.owned.lib.ended); self.assertEqual(self.owned.lib.freed, 1)
        self.assertTrue(self.owned.native_cleanup_complete); self.owned.cancel_stream()
        self.assertFalse(list(self.owned.cache.glob('*.wav')))
        context = self.owned.context
        _, recovered, _ = self.owned.complete('안녕.', 42)
        self.assertEqual(self.owned.context, context); self.assertEqual(self.owned.lib.freed, 2)
        _, expected = worker.pcm48(self.owned.lib.complete_audio, 24000)
        np.testing.assert_array_equal(recovered, expected)

    def test_already_written_credits_before_cancel_are_drained_in_pipe_order(self):
        def published(kind, rid, **fields):
            self.publish(kind, rid, **fields)
            self.cancel()
        with patch.object(worker, 'emit', published), self.assertRaises(StreamCancelled):
            self.owned.stream(self.request, self.control)
        self.assertEqual(self.control.received, 1); self.assertFalse(self.queue.items)
        self.owned.cancel_stream()
        self.owned.complete('안녕.', 42)
        self.assertEqual(self.owned.lib.freed, 2)

    def test_credit_wait_cancellation_is_bounded_to_three_uncredited_chunks(self):
        self.owned.lib = FakeLib(frames=20)
        self.queue.on_wait = self.cancel
        with patch.object(worker, 'emit', lambda kind, rid, **fields:self.events.append(fields)), self.assertRaises(StreamCancelled) as caught:
            self.owned.stream(self.request, self.control)
        self.assertEqual(len(self.events), 3); self.assertEqual(caught.exception.boundary, 'credit-wait')
        self.assertEqual(self.owned.lib.freed, 1); self.owned.cancel_stream()
        self.assertFalse(list(self.owned.cache.glob('*.wav')))

    def test_wrong_target_does_not_escape_callback_or_report_warm_cleanup(self):
        self.queue.items.append(dict(protocolVersion=1, type='cancel-stream', requestId='cancel', target=dict(stream_target(self.request), speechEpoch=2)))
        with self.assertRaisesRegex(ValueError, 'STREAM_CANCEL_BINDING'):
            self.owned.stream(self.request, self.control)
        self.assertEqual(self.owned.lib.freed, 1)

    def test_cancel_native_error_cannot_be_acknowledged_as_clean(self):
        self.owned.lib.fail_retirement = True; self.cancel()
        with self.assertRaisesRegex(ValueError, 'STREAM_CLEANUP'):
            self.owned.stream(self.request, self.control)
        self.assertEqual(self.owned.lib.freed, 1)

    def test_nonfinite_native_chunk_rejected_then_buffer_freed(self):
        self.owned.lib.bad_pcm = True
        with self.assertRaisesRegex(ValueError, 'VOICE_INVALID_WAV'):
            self.owned.stream(self.request, self.control)
        self.assertEqual(self.owned.lib.freed, 1); self.assertFalse(self.events)

    def test_incomplete_native_entry_prevents_warm_ack(self):
        self.owned.lib.abort_entry = True
        with self.assertRaises(OSError):
            self.owned.complete('안녕.', 42)
        self.assertFalse(self.owned.native_cleanup_complete)
        with self.assertRaisesRegex(ValueError, 'STREAM_CLEANUP'):
            self.owned.cancel_stream()


class TerminalCredits(unittest.TestCase):
    def test_final_credits_then_cancel_then_next_stream_share_worker(self):
        session = str(uuid.uuid4()); synthesis = str(uuid.uuid4())
        first = dict(protocolVersion=1, type='stream', requestId='first', synthesisId=synthesis,
                     binding=dict(runtimeSessionId=session, speechEpoch=1))
        second = dict(first, requestId='second', synthesisId=str(uuid.uuid4()), binding=dict(runtimeSessionId=session, speechEpoch=2))
        requests = deque([dict(protocolVersion=1, type='init', requestId='init'), first,
                          dict(protocolVersion=1, type='credit', requestId='first', chunkIndex=0),
                          dict(protocolVersion=1, type='credit', requestId='first', chunkIndex=1),
                          dict(protocolVersion=1, type='cancel-stream', requestId='cancel', target=stream_target(first)), second,
                          dict(protocolVersion=1, type='credit', requestId='second', chunkIndex=0),
                          dict(protocolVersion=1, type='credit', requestId='second', chunkIndex=1),
                          dict(protocolVersion=1, type='shutdown', requestId='shutdown')])
        emitted = []; created = []
        class FakeWorker:
            def __init__(self):
                created.append(self); self.cleanup = True; self.closed = False; self.streams = []
            def initialize(self, _):
                return dict(ready=True)
            def stream(self, request, _):
                self.streams.append(request['requestId']); self.cleanup = True
                return dict(totalChunks=2)
            def cancel_stream(self):
                assert self.cleanup
            def reuse_audit(self):
                return dict(referenceCacheBuilds=1)
            def close(self):
                self.closed = True
        class FakeInbox:
            def __init__(self, _): pass
            def take(self):
                if not requests: raise EOFError()
                return requests.popleft()
            def close(self): pass
        def read(_):
            return requests.popleft()
        with patch.object(worker, 'GgufWorker', FakeWorker), patch.object(worker, 'Inbox', FakeInbox), \
             patch.object(worker, 'read_request', read), patch.object(worker, 'emit', lambda kind,rid,**fields:emitted.append(dict(type=kind, requestId=rid, **fields))):
            worker.main()
        self.assertEqual(len(created), 1); self.assertEqual(created[0].streams, ['first', 'second']); self.assertTrue(created[0].closed)
        self.assertFalse([e for e in emitted if e['type']=='error'])
        cancelled = next(e for e in emitted if e['requestId']=='cancel')
        self.assertEqual(cancelled['target'], stream_target(first)); self.assertTrue(cancelled['cleanupComplete']); self.assertTrue(cancelled['keptWarm'])

    def test_cancel_for_foreign_terminal_epoch_is_rejected(self):
        first = dict(protocolVersion=1, type='stream', requestId='first', synthesisId=str(uuid.uuid4()),
                     binding=dict(runtimeSessionId=str(uuid.uuid4()), speechEpoch=1))
        requests = deque([dict(protocolVersion=1, type='init', requestId='init'), first,
                          dict(protocolVersion=1, type='cancel-stream', requestId='cancel', target=dict(stream_target(first),speechEpoch=2))])
        emitted = []
        class FakeWorker:
            def initialize(self, _): return dict(ready=True)
            def stream(self, *_): return dict(totalChunks=1)
            def cancel_stream(self): raise AssertionError('foreign target cleaned')
            def close(self): pass
        class FakeInbox:
            def __init__(self, _): pass
            def take(self): return requests.popleft()
            def close(self): pass
        with patch.object(worker, 'GgufWorker', FakeWorker), patch.object(worker, 'Inbox', FakeInbox), \
             patch.object(worker, 'read_request', lambda _:requests.popleft()), \
             patch.object(worker, 'emit', lambda kind,rid,**fields:emitted.append(dict(type=kind, requestId=rid, **fields))):
            worker.main()
        self.assertEqual(emitted[-1], dict(type='error', requestId='cancel', code='STREAM_CANCEL_BINDING'))


if __name__ == '__main__':
    if '--require-pcm' in sys.argv:
        sys.argv.remove('--require-pcm')
        if not HAVE_PCM:
            raise SystemExit('numpy/scipy are missing; refusing to skip native callback PCM tests')
    unittest.main()
