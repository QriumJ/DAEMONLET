"""Standard-library protocol tests; these do not load weights or prove synthesis."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

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


if __name__ == "__main__":
    unittest.main()
