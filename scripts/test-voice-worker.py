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


if __name__ == "__main__":
    unittest.main()
