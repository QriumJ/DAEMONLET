"""Small synthetic files prove skipped bytes and full-check recovery semantics."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'electron/voice'))
from windows_model_check import check_model

class Checks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name).resolve()
        self.files = {}
        for name, data in [('model.safetensors', b'weights'), ('config.json', b'config'), ('tokenization.py', b'code')]:
            (self.root/name).write_bytes(data)
            self.files[name] = dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
    def tearDown(self): self.temp.cleanup()
    def test_installed_deliberately_does_not_detect_same_size_weight_corruption(self):
        (self.root/'model.safetensors').write_bytes(b'changed')
        result = check_model(self.root, self.files, 'installed', True)
        self.assertEqual(result['modelSkippedWeightBytes'], 7)
        self.assertFalse(result['weightIntegrityChecked'])
        with self.assertRaises(ValueError): check_model(self.root, self.files, 'full', True)
    def test_small_code_always_checked(self):
        (self.root/'tokenization.py').write_bytes(b'evil')
        with self.assertRaises(ValueError): check_model(self.root, self.files, 'installed')
    def test_size_missing_extra_and_bad_policy(self):
        with self.assertRaises(ValueError): check_model(self.root, self.files, 'skip')
        (self.root/'extra.py').write_bytes(b'extra')
        with self.assertRaises(ValueError): check_model(self.root, self.files, 'installed', True)
        (self.root/'extra.py').unlink(); (self.root/'model.safetensors').write_bytes(b'short')
        with self.assertRaises(ValueError): check_model(self.root, self.files, 'installed')
        (self.root/'model.safetensors').unlink()
        with self.assertRaises(ValueError): check_model(self.root, self.files, 'installed')
    def test_full_good_and_link_rejection(self):
        self.assertTrue(check_model(self.root, self.files, 'full', True)['weightIntegrityChecked'])
        link=self.root/'linked'; link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError): check_model(link, self.files, 'installed')

if __name__ == '__main__': unittest.main()
