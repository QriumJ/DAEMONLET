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


class ProtocolTests(unittest.TestCase):
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
        with tempfile.TemporaryDirectory() as cache, patch("sys.platform", "win32"), patch.dict("sys.modules", {"torch": fake}), patch.dict("os.environ"):
            with self.assertRaisesRegex(module["WorkerError"], "UNSUPPORTED_DEVICE"):
                module["Worker"]().initialize({"cache": cache})

    def test_error_allowlist_does_not_expose_arbitrary_messages(self):
        module = runpy.run_path(str(WORKER))
        classify = module["error_code"]
        self.assertEqual(classify(module["WorkerError"]("UNSUPPORTED_DEVICE")), "UNSUPPORTED_DEVICE")
        self.assertEqual(classify(ValueError("MODEL_CHANGED")), "MODEL_CHANGED")
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


if __name__ == "__main__":
    unittest.main()
