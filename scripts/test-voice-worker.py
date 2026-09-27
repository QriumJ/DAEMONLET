"""Standard-library protocol tests; these do not load weights or prove synthesis."""
import json
from pathlib import Path
import subprocess
import sys
import unittest
import runpy
import io
from types import SimpleNamespace
from unittest.mock import patch

WORKER = Path(__file__).resolve().parents[1] / "electron/voice/worker.py"
sys.path.insert(0, str(WORKER.parent))
from engine import Engine, runtime_fingerprint
from backend import CudaDevice, MpsDevice, select_backend
from control import Inbox, StreamControl, StreamCancelled


class ProtocolTests(unittest.TestCase):
    def test_active_credit_wait_cancellation_recovers_same_worker(self):
        module = runpy.run_path(str(WORKER))
        closed = []
        binding = dict(runtimeSessionId='session', speechEpoch=1)
        request = dict(type='stream', requestId='old', synthesisId='s', binding=binding)
        target = dict(requestId='old', synthesisId='s', **binding)
        requests = [dict(type='init', requestId='i'), request,
                    dict(type='cancel-stream', requestId='cancel', target=target),
                    dict(type='health', requestId='new')]
        def stream(self, request, credit):
            try:
                credit(3)
                self.fail('generation must not finish')
            finally:
                closed.append('generator-closed')
        def cleanup(self):
            closed.append('state-cleaned')
        output = io.StringIO()
        module['emit'].__globals__['PROTOCOL'] = output
        with patch.object(module['Worker'], 'initialize', lambda self, request: {}), patch.object(module['Worker'], 'stream', stream), patch.object(module['Worker'], 'cancel_stream', cleanup, create=True), patch.object(module['Worker'], 'reuse_audit', lambda self: {}), patch('sys.stdin', io.StringIO(''.join(json.dumps(dict(protocolVersion=1, **r))+'\n' for r in requests))):
            module['main']()
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([v['type'] for v in replies], ['ready', 'synthesis-started', 'cancelled', 'ready'])
        self.assertEqual(replies[2]['target'], target)
        self.assertEqual(closed, ['generator-closed', 'state-cleaned'])

    def test_cleanup_failure_never_acknowledges_or_accepts_successor(self):
        module = runpy.run_path(str(WORKER))
        request = dict(type='stream', requestId='old', synthesisId='s', binding={})
        target = dict(requestId='old', synthesisId='s', runtimeSessionId=None, speechEpoch=None)
        requests = [dict(type='init', requestId='i'), request, dict(type='cancel-stream', requestId='cancel', target=target), dict(type='health', requestId='successor')]
        def stream(self, request, credit):
            credit(3)
        def cleanup(self):
            raise ValueError('STREAM_CLEANUP')
        output = io.StringIO()
        module['emit'].__globals__['PROTOCOL'] = output
        with patch.object(module['Worker'], 'initialize', lambda self, request: {}), patch.object(module['Worker'], 'stream', stream), patch.object(module['Worker'], 'cancel_stream', cleanup), patch('sys.stdin', io.StringIO(''.join(json.dumps(dict(protocolVersion=1, **r))+'\n' for r in requests))):
            module['main']()
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([v['type'] for v in replies], ['ready', 'synthesis-started', 'error'])
        self.assertEqual(replies[-1]['code'], 'STREAM_CLEANUP')

    def test_native_initialization_finishes_before_stdin_reader_starts(self):
        module = runpy.run_path(str(WORKER))
        events = []
        def initialize(worker, request):
            events.append('native-ready')
            return {}
        def inbox(source):
            events.append('reader-start')
            return Inbox(source)
        output = io.StringIO()
        module['emit'].__globals__['PROTOCOL'] = output
        module['main'].__globals__['Inbox'] = inbox
        requests = [dict(protocolVersion=1, type='init', requestId='i'), dict(protocolVersion=1, type='health', requestId='h')]
        with patch.object(module['Worker'], 'initialize', initialize), patch('sys.stdin', io.StringIO(''.join(json.dumps(r)+'\n' for r in requests))):
            module['main']()
        self.assertEqual(events, ['native-ready', 'reader-start'])
        self.assertEqual([json.loads(line)['type'] for line in output.getvalue().splitlines()], ['ready', 'ready'])

    def run_worker(self, lines):
        result = subprocess.run([sys.executable, "-B", "-u", str(WORKER)], input=lines, text=True,
                                capture_output=True, timeout=10, encoding="utf-8")
        return [json.loads(line) for line in result.stdout.splitlines()]

    def test_health_shutdown(self):
        lines = "".join(json.dumps(dict(protocolVersion=1, requestId=str(i), type=kind))+"\n"
                        for i, kind in enumerate(("health", "cancel", "shutdown")))
        self.assertEqual([v["type"] for v in self.run_worker(lines)], ["ready", "cancelled", "cancelled"])

    def test_malformed_json_is_a_bounded_error(self):
        result = self.run_worker("not-json\n")
        self.assertEqual(result[0]["type"], "error")
        self.assertNotIn("Traceback", json.dumps(result))

    def test_wrong_protocol(self):
        result = self.run_worker('{"type":"health","protocolVersion":2,"requestId":"x"}\n')
        self.assertEqual(result[0]["code"], "PROTOCOL_VERSION")

    def test_synthesis_requires_verified_initialization(self):
        result = self.run_worker('{"type":"synthesize","protocolVersion":1,"requestId":"x"}\n')
        self.assertEqual(result[0]["code"], "PROTOCOL_STATE")


class DeviceTests(unittest.TestCase):
    def test_unsupported_device_protocol(self):
        old_stdout = sys.stdout
        try:
            module = runpy.run_path(str(WORKER))
        finally:
            sys.stdout = old_stdout
        fake = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False, is_bf16_supported=lambda: False))
        def initialize(self, request):
            module["CudaDevice"].require(fake)
        output = io.StringIO()
        module["emit"].__globals__["PROTOCOL"] = output
        with patch.object(module["Worker"], "initialize", initialize), patch("sys.stdin", io.StringIO('{"protocolVersion":1,"requestId":"device","type":"init"}\n')):
            module["main"]()
        self.assertEqual(json.loads(output.getvalue())["code"], "UNSUPPORTED_DEVICE")

    def test_device_matrix_and_early_rejection(self):
        module = runpy.run_path(str(WORKER))
        for platform, cuda, bf16, supported in [
            ("linux", True, True, False), ("darwin", True, True, False),
            ("win32", False, True, False), ("win32", True, False, False),
            ("win32", True, True, True),
        ]:
            with self.subTest(platform=platform, cuda=cuda, bf16=bf16):
                fake = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: cuda, is_bf16_supported=lambda: bf16))
                with patch("sys.platform", platform):
                    if supported:
                        module["CudaDevice"].require(fake)
                    else:
                        with self.assertRaises(module["WorkerError"]):
                            module["CudaDevice"].require(fake)
        # Non-Windows init fails before request paths, filesystem hashing or torch imports.
        with patch("sys.platform", "darwin"):
            with self.assertRaisesRegex(module["WorkerError"], "UNSUPPORTED_DEVICE"):
                module["Worker"]().initialize({})

    def test_no_cuda_rejects_before_package_hashing(self):
        import tempfile
        module = runpy.run_path(str(WORKER))
        fake = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))
        with tempfile.TemporaryDirectory() as cache, patch("sys.platform", "win32"), patch.dict("sys.modules", {"torch": fake, "soundfile": None}), patch.dict("os.environ"):
            with self.assertRaisesRegex(module["WorkerError"], "UNSUPPORTED_DEVICE"):
                module["Worker"]().initialize({"cache": cache})

    def test_error_allowlist_does_not_expose_arbitrary_messages(self):
        module = runpy.run_path(str(WORKER))
        classify = module["error_code"]
        self.assertEqual(classify(module["WorkerError"]("UNSUPPORTED_DEVICE")), "UNSUPPORTED_DEVICE")
        self.assertEqual(classify(ValueError("MODEL_CHANGED")), "MODEL_CHANGED")
        self.assertEqual(classify(ModuleNotFoundError("private module path")), "RUNTIME_DEPENDENCY")
        self.assertEqual(classify(RuntimeError("UNSUPPORTED_DEVICE")), "TTS_FAILED")
        self.assertEqual(classify(ValueError("PRIVATE_SECRET")), "TTS_FAILED")
        self.assertEqual(classify(RuntimeError("private/path dialogue")), "TTS_FAILED")
        self.assertEqual(classify(RuntimeError("CUDA out of memory private/path")), "CUDA_OOM")


class CacheTests(unittest.TestCase):
    def engine(self, profile='cached'):
        calls = []
        tensor = SimpleNamespace(squeeze=lambda _: tensor, cpu=lambda: tensor, numpy=lambda: [0.1, 0.2])
        def build(**kwargs):
            calls.append(('reference', kwargs))
            return {'mode': 'reference', 'fixed': True}
        def generate(**kwargs):
            calls.append(('generate', kwargs))
            return tensor, 'ignored', 'never appended'
        tts = SimpleNamespace(build_prompt_cache=build, generate_with_prompt_cache=generate)
        settings = dict(cfg_value=2, inference_timesteps=10, retry_badcase=False, max_len=600, seed=42, normalize=False, denoise=False)
        return Engine(SimpleNamespace(tts_model=tts), 'fixed-reference', settings, profile), calls, tts, tensor

    def test_fixed_reference_once_and_public_arguments(self):
        engine, calls, _, _ = self.engine()
        fake = SimpleNamespace(cuda=SimpleNamespace(synchronize=lambda: None))
        with patch.dict('sys.modules', {'torch': fake}):
            engine.prepare()
            list(engine.generate('응.\n  다음 문장'))
            list(engine.generate('새 문장'))
        self.assertEqual(engine.cache_builds, 1)
        self.assertEqual([c[0] for c in calls], ['reference', 'generate', 'generate'])
        first, second = calls[1][1], calls[2][1]
        self.assertEqual(first['target_text'], '응. 다음 문장')
        self.assertIs(first['prompt_cache'], second['prompt_cache'])
        self.assertEqual(second['prompt_cache'], {'mode': 'reference', 'fixed': True})
        self.assertNotIn('normalize', first)
        self.assertNotIn('denoise', first)

    def test_default_voice_design_without_reference_in_both_paths(self):
        defaults = json.loads((WORKER.parent / 'base-voice-defaults.json').read_text())
        engine, calls, tts, tensor = self.engine()
        engine.reference = None
        engine.voice_description = defaults['description']
        engine.settings['seed'] = defaults['seed']
        def streaming(**kwargs):
            calls.append(('stream', kwargs))
            yield tensor, None, None
        tts.generate_with_prompt_cache_streaming = streaming
        with patch.dict('sys.modules', {'torch': SimpleNamespace()}):
            engine.prepare()
            list(engine.generate('안녕.'))
            list(engine.generate('안녕.', streaming=True))
        self.assertEqual(engine.cache_builds, 0)
        self.assertEqual([c[0] for c in calls], ['generate', 'stream'])
        for _, kwargs in calls:
            self.assertEqual(kwargs['target_text'], '(' + defaults['description'] + ') 안녕.')
            self.assertIsNone(kwargs['prompt_cache'])
            self.assertEqual(kwargs['seed'], 42)

    def test_stream_is_incremental_and_closes_generator(self):
        engine, _, tts, tensor = self.engine()
        events = []
        def streaming(**kwargs):
            try:
                events.append('first')
                yield tensor, None, None
                events.append('tail')
                yield tensor, None, None
            finally:
                events.append('closed')
        tts.generate_with_prompt_cache_streaming = streaming
        generated = engine.generate('응', streaming=True)
        self.assertEqual(next(generated), [0.1, 0.2])
        self.assertEqual(events, ['first'])
        generated.close()
        self.assertEqual(events, ['first', 'closed'])

    def test_compile_flag_without_execution_is_not_effective(self):
        engine, _, _, _ = self.engine('compiled')
        engine.compile_counts = {'base': dict(graphs=1, executions=0)}
        with patch.dict('sys.modules', {'torch': SimpleNamespace(cuda=SimpleNamespace(synchronize=lambda: None))}):
            with self.assertRaisesRegex(ValueError, 'COMPILE_UNAVAILABLE'):
                engine.warmup()
        self.assertFalse(engine.audit['warmupCompleted'])
        self.assertEqual(engine.audit['compileEffectiveByComponent'], {'base': False})

    def test_profile_and_reference_change_runtime_identity(self):
        self.assertNotEqual(runtime_fingerprint('cached', {'reference': 'a'}), runtime_fingerprint('compiled', {'reference': 'a'}))
        self.assertNotEqual(runtime_fingerprint('cached', {'reference': 'a'}), runtime_fingerprint('cached', {'reference': 'b'}))

    def test_tail_credits_do_not_poison_next_control_request(self):
        module = runpy.run_path(str(WORKER))
        def stream(self, request, credit):
            for i in range(6):
                credit(i)
            return dict(totalChunks=5, totalSamples=100)
        requests = [dict(type='init', requestId='i'), dict(type='stream', requestId='s')]
        requests += [dict(type='credit', requestId='s', chunkIndex=i) for i in range(5)]
        requests += [dict(type='health', requestId='h')]
        output = io.StringIO()
        module['emit'].__globals__['PROTOCOL'] = output
        with patch.object(module['Worker'], 'initialize', lambda self, request: {}), patch.object(module['Worker'], 'stream', stream), patch('sys.stdin', io.StringIO(''.join(json.dumps(dict(protocolVersion=1, **r))+'\n' for r in requests))):
            module['main']()
        self.assertEqual([json.loads(line)['type'] for line in output.getvalue().splitlines()], ['ready', 'synthesis-started', 'synthesis-finished', 'ready'])

    def test_worker_accepts_silent_prefix_and_preserves_small_tail(self):
        import tempfile
        module = runpy.run_path(str(WORKER))
        emitted = []
        module['emit'].__globals__['emit'] = lambda kind, request_id, **value: emitted.append(value)
        np = SimpleNamespace(asarray=lambda a: a, isfinite=lambda a: SimpleNamespace(all=lambda: True), max=lambda a: a.peak, abs=lambda a: a)
        cuda = SimpleNamespace(reset_peak_memory_stats=lambda: None, synchronize=lambda: None, max_memory_allocated=lambda: 1, max_memory_reserved=lambda: 1)
        sf = SimpleNamespace(write=lambda path, *args, **kwargs: path.touch())
        with tempfile.TemporaryDirectory() as cache, patch.dict('sys.modules', {'numpy': np, 'torch': SimpleNamespace(cuda=cuda), 'soundfile': sf}):
            worker = module['Worker']()
            worker.backend = CudaDevice
            worker.cache = Path(cache)
            worker.model = SimpleNamespace(tts_model=SimpleNamespace(sample_rate=48000))
            worker.engine = SimpleNamespace(generate=lambda *a, **k: iter_chunks())
            def iter_chunks():
                yield SimpleNamespace(ndim=1, size=7680, peak=0)
                yield SimpleNamespace(ndim=1, size=13, peak=0.1)
            result = worker.stream(dict(text='응.', style=None, streamVersion=1, requestId='s', binding={}, synthesisId='s', segmentIndex=0), lambda index: None)
        self.assertEqual(result['totalSamples'], 7693)
        self.assertEqual(result['totalChunks'], 2)
        self.assertEqual([v['sampleOffset'] for v in emitted], [0, 7680])
        self.assertEqual([v['sampleCount'] for v in emitted], [7680, 13])
        self.assertGreaterEqual(result['firstSignalChunkReadyMs'], result['firstChunkReadyMs'])

    def test_retired_tail_credits_interleave_with_new_stream_repeatedly(self):
        # Real worker main/credit parser; only inference is synthetic. Retired
        # terminal streams have two outstanding credits while a successor runs.
        module = runpy.run_path(str(WORKER))
        def stream(self, request, credit):
            count = request['count']
            for i in range(count + 1):
                credit(i)
            return dict(totalChunks=count, totalSamples=count * 4800)
        requests = [dict(type='init', requestId='init')]
        for cycle in range(3):
            old, new = f'old-{cycle}', f'new-{cycle}'
            requests += [dict(type='stream', requestId=old, count=2), dict(type='stream', requestId=new, count=5)]
            requests += [dict(type='credit', requestId=old, chunkIndex=i) for i in range(2)]
            requests += [dict(type='credit', requestId=new, chunkIndex=i) for i in range(5)]
        requests += [dict(type='health', requestId='end')]
        output = io.StringIO()
        module['emit'].__globals__['PROTOCOL'] = output
        with patch.object(module['Worker'], 'initialize', lambda self, request: {}), patch.object(module['Worker'], 'stream', stream), patch('sys.stdin', io.StringIO(''.join(json.dumps(dict(protocolVersion=1, **r))+'\n' for r in requests))):
            module['main']()
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([v['type'] for v in replies], ['ready'] + ['synthesis-started', 'synthesis-finished'] * 6 + ['ready'])
        self.assertEqual(replies[-1]['requestId'], 'end')



class CancellationTests(unittest.TestCase):
    def test_reader_is_bounded(self):
        inbox = Inbox(io.StringIO((json.dumps(dict(protocolVersion=1, type='health', requestId='h'))+'\n')*100))
        try:
            with inbox.condition:
                self.assertTrue(inbox.condition.wait_for(lambda: len(inbox.items) == 32, timeout=2))
                self.assertEqual(len(inbox.items), 32)
            self.assertTrue(inbox.thread.is_alive())
        finally:
            inbox.close()
            inbox.thread.join(2)
        self.assertFalse(inbox.thread.is_alive())

    def test_cancel_during_next_discards_chunk_and_closes_on_owner_thread(self):
        import queue
        import tempfile
        import threading
        lines = queue.Queue()
        inbox = Inbox(SimpleNamespace(readline=lambda limit: lines.get()))
        module = runpy.run_path(str(WORKER))
        emitted, events = [], []
        module['emit'].__globals__['emit'] = lambda *a, **k: emitted.append(k)
        request = dict(streamVersion=1, requestId='old', synthesisId='s', text='test', binding=dict(runtimeSessionId='session', speechEpoch=1))
        target = dict(requestId='old', synthesisId='s', **request['binding'])
        def generate(*args, **kwargs):
            try:
                events.append(('next', threading.get_ident()))
                lines.put(json.dumps(dict(protocolVersion=1, type='cancel-stream', requestId='c', target=target))+'\n')
                inbox.peek(True)
                yield object()
            finally:
                events.append(('closed', threading.get_ident()))
        try:
            with tempfile.TemporaryDirectory() as cache, patch.dict('sys.modules', {'numpy': SimpleNamespace(asarray=lambda a: a), 'soundfile': SimpleNamespace(), 'torch': SimpleNamespace(cuda=SimpleNamespace(reset_peak_memory_stats=lambda: None))}):
                worker = module['Worker']()
                worker.backend = CudaDevice
                worker.cache = Path(cache)
                worker.model = SimpleNamespace(tts_model=SimpleNamespace(sample_rate=48000))
                worker.engine = SimpleNamespace(generate=generate)
                with self.assertRaises(StreamCancelled) as raised:
                    worker.stream(request, StreamControl(inbox, request, lambda _: False))
                self.assertEqual(raised.exception.boundary, 'chunk-boundary')
                self.assertEqual(list(Path(cache).iterdir()), [])
            self.assertEqual(emitted, [])
            self.assertEqual(events, [('next', threading.get_ident()), ('closed', threading.get_ident())])
            self.assertNotEqual(threading.get_ident(), inbox.thread.ident)
        finally:
            inbox.close()
            lines.put('')
            inbox.thread.join(2)

    def test_cancel_cleanup_clears_kv_in_place_and_preserves_reference(self):
        import contextlib
        import tempfile
        module = runpy.run_path(str(WORKER))
        events = []
        caches = [SimpleNamespace(kv_cache=SimpleNamespace(zero_=lambda: events.append('zero')), current_length=25) for _ in range(2)]
        buffers = [cache.kv_cache for cache in caches]
        reference = object()
        mod = SimpleNamespace(forward=object())
        torch = SimpleNamespace(inference_mode=contextlib.nullcontext, cuda=SimpleNamespace(synchronize=lambda: events.append('sync')))
        with tempfile.TemporaryDirectory() as cache, patch.dict('sys.modules', {'torch': torch}):
            worker = module['Worker']()
            worker.backend = CudaDevice
            worker.model = SimpleNamespace(tts_model=SimpleNamespace(base_lm=SimpleNamespace(kv_cache=caches[0]), residual_lm=SimpleNamespace(kv_cache=caches[1])))
            worker.engine = SimpleNamespace(cache=reference)
            worker.vae_forwards = [(mod, mod.forward)]
            owned = Path(cache)/'owned.wav'
            owned.touch()
            worker.stream_files = [owned]
            worker.cancel_stream()
            self.assertFalse(owned.exists())
            self.assertEqual(events, ['zero', 'zero', 'sync'])
            self.assertIs(worker.engine.cache, reference)
            for state, buffer in zip(caches, buffers):
                self.assertIs(state.kv_cache, buffer)
                self.assertEqual(state.current_length, 0)
            mod.forward = object()
            with self.assertRaisesRegex(ValueError, 'STREAM_CLEANUP'):
                worker.cancel_stream()

    def test_wrong_cancel_identity_is_not_acknowledged(self):
        request = dict(requestId='old', synthesisId='s', binding=dict(runtimeSessionId='session', speechEpoch=1))
        inbox = Inbox(io.StringIO(json.dumps(dict(protocolVersion=1, type='cancel-stream', requestId='c', target={}))+'\n'))
        try:
            inbox.peek(True)
            with self.assertRaisesRegex(ValueError, 'STREAM_CANCEL_BINDING'):
                StreamControl(inbox, request, lambda _: False)(3)
        finally:
            inbox.close()


class MpsTests(unittest.TestCase):
    def test_platform_arch_profile_and_override_matrix(self):
        import os
        for host, arch, profile, good in [
            ('darwin','arm64','mps-fp32',True), ('darwin','arm64','mps-fp32-baseline',True),
            ('darwin','x86_64','mps-fp32',False), ('win32','AMD64','mps-fp32',False),
            ('darwin','arm64','compiled',False), ('linux','aarch64','mps-fp32',False),
            ('win32','AMD64','compiled',True), ('win32','AMD64','cached',True),
        ]:
            with self.subTest(host=host,arch=arch,profile=profile), patch('sys.platform',host), patch('platform.machine',lambda:arch), patch.dict(os.environ,{},clear=True):
                if good:
                    self.assertEqual(select_backend(profile).device,'mps' if host=='darwin' else 'cuda')
                else:
                    with self.assertRaisesRegex(Exception,'UNSUPPORTED_DEVICE'):
                        select_backend(profile)
        for key,value in [('VOXCPM_MPS_DTYPE','bf16'),('VOXCPM_MPS_DTYPE','fp16'),('PYTORCH_ENABLE_MPS_FALLBACK','1')]:
            with patch('sys.platform','darwin'), patch('platform.machine',lambda:'arm64'), patch.dict(os.environ,{key:value},clear=True):
                with self.assertRaisesRegex(Exception,'RUNTIME_POLICY'):
                    select_backend('mps-fp32')

    def test_mps_availability_and_memory_never_use_cuda(self):
        calls=[]
        class Forbidden:
            def __getattr__(self,name):
                raise AssertionError('CUDA touched on MPS: '+name)
        fake=SimpleNamespace(cuda=Forbidden(),backends=SimpleNamespace(mps=SimpleNamespace(is_built=lambda:True,is_available=lambda:True)),mps=SimpleNamespace(synchronize=lambda:calls.append('mps-sync'),current_allocated_memory=lambda:123,driver_allocated_memory=lambda:456))
        with patch('sys.platform','darwin'),patch('platform.machine',lambda:'arm64'),patch.dict('os.environ',{},clear=True):
            MpsDevice.require(fake)
            MpsDevice.synchronize(fake)
            MpsDevice.begin_measurement(fake)
            self.assertEqual(MpsDevice.memory(fake),dict(mpsCurrentAllocatedBytes=123,mpsDriverAllocatedBytes=456))
            fake.backends.mps.is_available=lambda:False
            with self.assertRaisesRegex(Exception,'UNSUPPORTED_DEVICE'):
                MpsDevice.require(fake)
        self.assertEqual(calls,['mps-sync'])

    def test_mps_cached_engine_uses_mps_sync_and_no_compile(self):
        engine,calls,tts,_=CacheTests().engine('mps-fp32')
        engine.backend=MpsDevice
        sync=[]
        with patch.dict('sys.modules',{'torch':SimpleNamespace(mps=SimpleNamespace(synchronize=lambda:sync.append('mps')))}):
            engine.prepare();engine.warmup()
        self.assertEqual(sync,['mps','mps'])
        self.assertEqual(engine.cache_builds,1)
        self.assertEqual(engine.compile_counts,{})
        self.assertFalse(engine.audit['compileRequested'])

    def test_mps_dtype_audit_and_oom_classification(self):
        tensor=SimpleNamespace(device=SimpleNamespace(type='mps'),dtype='fp32',is_floating_point=lambda:True)
        model=SimpleNamespace(parameters=lambda:[tensor])
        self.assertEqual(MpsDevice.audit_model(model,SimpleNamespace(float32='fp32'))['effectiveDevice'],'mps')
        tensor.dtype='bf16'
        with self.assertRaisesRegex(Exception,'RUNTIME_TENSORS'):
            MpsDevice.audit_model(model,SimpleNamespace(float32='fp32'))
        module=runpy.run_path(str(WORKER))
        self.assertEqual(module['error_code'](RuntimeError('MPS backend out of memory')),'MPS_OOM')

    def test_mac_receipt_rejects_tampering_without_relaxing_windows_provenance(self):
        import macos_runtime as runtime
        expected=runtime.policy()
        receipt=dict(schemaVersion=2,profile=expected['id'],policy_sha256='policy',lock_sha256=expected['lock_sha256'],source_commit=expected['source_commit'],source_files=expected['source_files'],dependencies=expected['dependencies'],interpreter=str(Path(sys.executable).resolve()),interpreter_sha256='exe',prefix=str(Path(sys.prefix).resolve()))
        with patch('sys.platform','darwin'),patch('platform.machine',lambda:'arm64'),patch('platform.python_version',lambda:expected['python']),patch.object(runtime,'sha',lambda p:'policy' if p.name=='runtime-macos.json' else 'exe'):
            broken=dict(receipt,lock_sha256='modified')
            with self.assertRaisesRegex(ValueError,'RUNTIME_RECEIPT'):runtime.verify_runtime(broken)
            broken=dict(receipt,source_files={})
            with self.assertRaisesRegex(ValueError,'RUNTIME_SOURCE'):runtime.verify_runtime(broken)
            broken=dict(receipt,interpreter='/other/python')
            with self.assertRaisesRegex(ValueError,'RUNTIME_RECEIPT'):runtime.verify_runtime(broken)
            with patch.object(runtime.metadata,'version',lambda name:'unexpected'):
                with self.assertRaisesRegex(ValueError,'RUNTIME_VERSION'):runtime.verify_runtime(receipt)

if __name__ == "__main__":
    unittest.main()
