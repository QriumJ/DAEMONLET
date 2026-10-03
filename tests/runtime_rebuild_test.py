"""Offline library rebuild trust boundaries; no replacement binary is executed."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('runtime_rebuild', ROOT / 'scripts/runtime/rebuild-libsndfile-component.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RebuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.voice = self.root / 'electron/voice'
        self.voice.mkdir(parents=True)
        self.archive = self.root / 'shared.zip'
        self.dll = self.root / 'replacement.dll'
        self.dll.write_bytes(b'MZ-user-modified-test-data')
        self.output = self.root / 'output'
        with zipfile.ZipFile(self.archive, 'w') as archive:
            archive.writestr(module.LIBRARY, b'MZ-original-test-data')
            archive.writestr('licenses/COPYING', b'original license')
        self.component = dict(id='shared', archive=dict(name='shared.zip', format='zip',
            bundledPath='shared.zip', **module.pin(self.archive.read_bytes())),
            files={module.LIBRARY: module.pin(b'MZ-original-test-data'),
                   'licenses/COPYING': module.pin(b'original license')}, provenance=dict(kind='test-data'))
        self.catalog = dict(schemaVersion=1, components=dict(shared=self.component), runtimes={})
        self.write_source()

    def write_source(self):
        raw = (json.dumps(self.catalog) + '\n').encode()
        (self.voice / 'managed-gguf-runtime-catalog.json').write_bytes(raw)
        for name in module.POLICIES:
            (self.voice / name).write_text(json.dumps(dict(managedRuntimeCatalog=dict(
                filename='managed-gguf-runtime-catalog.json', **module.pin(raw)))))

    def rebuild(self):
        return module.rebuild(self.root, self.archive, self.dll, self.output)

    def test_modified_library_keeps_license_and_synchronizes_both_workers(self):
        result = self.rebuild()
        catalog = json.loads((self.output / 'managed-gguf-runtime-catalog.json').read_bytes())
        component = catalog['components']['shared']
        with zipfile.ZipFile(self.output / result['sharedArchive']['name']) as archive:
            self.assertEqual(archive.read(module.LIBRARY), self.dll.read_bytes())
            self.assertEqual(archive.read('licenses/COPYING'), b'original license')
        self.assertEqual(component['files']['licenses/COPYING'], self.component['files']['licenses/COPYING'])
        for name in module.POLICIES:
            self.assertEqual(json.loads((self.output / name).read_text())['managedRuntimeCatalog'], result['catalog'])
        self.assertFalse(result['dllExecuted'])
        self.assertFalse(result['installedAppChanged'])
        self.assertEqual(self.component['files'][module.LIBRARY], module.pin(b'MZ-original-test-data'))

    def test_rejects_changed_archive_without_writing_output(self):
        with self.archive.open('ab') as stream:
            stream.write(b'tampered')
        with self.assertRaises(ValueError): self.rebuild()
        self.assertFalse(self.output.exists())

    def test_rejects_file_tampering_even_with_matching_archive_pin(self):
        with zipfile.ZipFile(self.archive, 'w') as archive:
            archive.writestr(module.LIBRARY, b'MZ-tampered')
            archive.writestr('licenses/COPYING', b'original license')
        self.component['archive'].update(module.pin(self.archive.read_bytes()))
        self.write_source()
        with self.assertRaises(ValueError): self.rebuild()
        self.assertFalse(self.output.exists())

    def test_rejects_unsynchronized_worker_pin(self):
        (self.voice / module.POLICIES[1]).write_text('{"managedRuntimeCatalog":{}}')
        with self.assertRaises(ValueError): self.rebuild()
        self.assertFalse(self.output.exists())

    def test_preserves_existing_output(self):
        self.output.mkdir()
        marker = self.output / 'keep.txt'
        marker.write_text('preserve')
        with self.assertRaises(FileExistsError): self.rebuild()
        self.assertEqual(marker.read_text(), 'preserve')

    def test_rejects_unchanged_library(self):
        self.dll.write_bytes(b'MZ-original-test-data')
        with self.assertRaises(ValueError): self.rebuild()
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
