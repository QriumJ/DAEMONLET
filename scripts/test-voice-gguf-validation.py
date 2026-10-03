"""CPU-only Mac model-validation reuse and mutation/cancellation regressions."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'electron/voice'))
import gguf_runtime as runtime
import gguf_cache
import voice_package
from worker import sha


class ValidationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.base = self.root / 'model'
        self.base.mkdir()
        self.original = b'synthetic-model-weights' * 1024
        self.model = self.base / 'model.safetensors'
        self.model.write_bytes(self.original)
        files = {'model.safetensors': sha(self.model)}
        for name in ('config.json', 'audiovae.pth', 'tokenizer.json',
                     'tokenizer_config.json', 'special_tokens_map.json', 'tokenization_voxcpm2.py'):
            (self.base / name).write_bytes(b'synthetic-original-' + name.encode())
            files[name] = sha(self.base / name)
        self.snapshot = dict(model_id=runtime.MODEL, revision=runtime.REVISION, files=files)
        self.write_snapshot()
        self.native = self.root / 'native/daemonlet-voice-engine'
        self.native.parent.mkdir()
        self.native.write_bytes(b'synthetic-native-never-executed')
        self.executable = self.root / 'python'
        self.executable.write_bytes(b'synthetic-interpreter-never-executed')
        self.converter = self.root / 'converter/python'
        self.converter.parent.mkdir()
        self.converter.write_bytes(b'synthetic-converter-never-executed')
        (self.converter.parent / 'source.py').write_bytes(b'synthetic-source')
        self.policy_file = self.root / 'app/runtime-gguf-macos.json'
        self.policy_file.parent.mkdir()
        self.policy = dict(originalBaseSha256=files['model.safetensors'], sourceCommit='synthetic-source',
                           nativeFiles={'native/daemonlet-voice-engine': sha(self.native)},
                           converterFiles={'source.py': sha(self.converter.parent / 'source.py')})
        self.package = self.root / 'package'
        self.package.mkdir()
        (self.package / 'reference.wav').write_bytes(b'synthetic-not-audio')
        self.selected = dict(packageSha256='synthetic-package', adapterSha256='synthetic-adapter',
                             voice=dict(voice_id='synthetic', version='1', reference='reference.wav',
                                        engine=dict(model_revision=runtime.REVISION)))
        self.owner = SimpleNamespace(converter=None)
        self.derivative = self.root / 'derivative'
        (self.derivative / 'gguf').mkdir(parents=True)
        outputs = {}
        for name in ('VoxCPM2-BaseLM-F16.gguf', 'VoxCPM2-Acoustic-F16.gguf'):
            path = self.derivative / 'gguf' / name
            path.write_bytes(b'synthetic-not-a-model')
            outputs[name] = sha(path)
        self.manifest = dict(status='PASS_CONVERSION_ONLY', adapterKeys=384, mergedMatrices=192,
                             adapterSha256=self.selected['adapterSha256'], packageSha256=self.selected['packageSha256'],
                             originalBaseSha256=self.policy['originalBaseSha256'], mergeCount=1, ggufDtype='f16',
                             records=[{'ggufExactExpectedCastBytes': True}] * 192, ggufFiles=outputs)
        (self.derivative / 'conversion.json').write_text(json.dumps(self.manifest))
        self.secret = b'synthetic-test-secret-only'
        self.identity = gguf_cache.cache_identity(self.selected, self.policy, 'synthetic-recipe')
        gguf_cache.seal(self.derivative, self.identity, self.secret)
        self.prepare_calls = 0
        self.prepare_impl = self.prepare_cache
        self.write_policy_and_receipt()
        self.enterContext(patch.object(runtime, '__file__', str(self.policy_file.with_name('gguf_runtime.py'))))
        self.enterContext(patch.object(runtime.sys, 'platform', 'darwin'))
        self.enterContext(patch.object(runtime.sys, 'executable', str(self.executable)))
        self.enterContext(patch.object(runtime.platform, 'machine', return_value='arm64'))
        self.enterContext(patch.object(voice_package, 'verify_package', side_effect=lambda _: copy.deepcopy(self.selected)))
        self.enterContext(patch.object(gguf_cache, 'prepare', side_effect=lambda *args: self.prepare_impl(*args)))

    def write_snapshot(self):
        (self.base / 'snapshot-provenance.json').write_text(json.dumps(self.snapshot))

    def write_policy_and_receipt(self):
        self.policy_file.write_text(json.dumps(self.policy))
        receipt = dict(schemaVersion=2, profile='macos-arm64-gguf-f16-v1', prefix=str(self.root),
                       interpreter=str(self.executable), interpreter_sha256=sha(self.executable),
                       policySha256=sha(self.policy_file), sourceCommit=self.policy['sourceCommit'],
                       converterPython=str(self.converter), converterInterpreter=str(self.converter),
                       converterInterpreterSha256=sha(self.converter))
        (self.root / 'voice-runtime.json').write_text(json.dumps(receipt))

    def prepare_cache(self, cache, selected, policy, *args):
        self.prepare_calls += 1
        identity = gguf_cache.cache_identity(selected, policy, 'synthetic-recipe')
        gguf_cache.verify_cache(self.derivative, identity, self.secret)
        return self.derivative, dict(derivativeCache='hit', derivativeKey='synthetic')

    def validate(self):
        return runtime.validate(self.package, self.base, self.root / 'cache', self.owner, prefix=self.root)

    def model_hashes(self, callback):
        original = hashlib.file_digest
        seen = []
        def count(stream, *args, **kwargs):
            info = os.fstat(stream.fileno())
            model = self.model.stat()
            if (info.st_dev, info.st_ino) == (model.st_dev, model.st_ino):
                seen.append(info.st_size)
            return original(stream, *args, **kwargs)
        with patch.object(hashlib, 'file_digest', side_effect=count):
            callback()
        return seen

    def after_first_hash(self, mutation):
        original = runtime.sha
        def change(path):
            if path == self.native:
                mutation()
            return original(path)
        return patch.object(runtime, 'sha', side_effect=change)

    def test_one_full_model_hash_per_validate_including_a_new_request(self):
        calls = self.model_hashes(lambda: (self.validate(), self.validate()))
        self.assertEqual(calls, [len(self.original), len(self.original)])
        self.assertEqual(self.prepare_calls, 2)

    def test_public_verify_assets_result_unchanged(self):
        self.assertEqual(runtime.verify_assets(self.package, self.base), self.selected)

    def test_snapshot_and_independent_policy_pins_both_required(self):
        for target in ('snapshot', 'policy'):
            with self.subTest(target=target):
                if target == 'snapshot':
                    self.snapshot['files']['model.safetensors'] = '0' * 64
                    self.write_snapshot()
                else:
                    self.policy['originalBaseSha256'] = '0' * 64
                    self.write_policy_and_receipt()
                with self.assertRaisesRegex(ValueError, 'MODEL_CHANGED'):
                    self.validate()
                self.snapshot['files']['model.safetensors'] = sha(self.model)
                self.policy['originalBaseSha256'] = sha(self.model)
                self.write_snapshot()
                self.write_policy_and_receipt()
        self.assertEqual(self.prepare_calls, 0)

    def test_same_size_write_with_restored_mtime_rejected_by_ctime(self):
        before = self.model.stat()
        def change():
            self.model.write_bytes(b'x' * len(self.original))
            os.utime(self.model, ns=(before.st_atime_ns, before.st_mtime_ns))
        with self.after_first_hash(change), self.assertRaisesRegex(ValueError, 'MODEL_CHANGED'):
            self.validate()
        self.assertEqual(self.model.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(self.prepare_calls, 0)

    def test_same_bytes_path_replacement_rejected_by_inode(self):
        def replace():
            replacement = self.base / 'replacement'
            replacement.write_bytes(self.original)
            replacement.replace(self.model)
        with self.after_first_hash(replace), self.assertRaisesRegex(ValueError, 'MODEL_CHANGED'):
            self.validate()
        self.assertEqual(self.prepare_calls, 0)

    def test_size_change_rejected(self):
        with self.after_first_hash(lambda: self.model.write_bytes(self.original + b'extra')):
            with self.assertRaisesRegex(ValueError, 'MODEL_CHANGED'):
                self.validate()
        self.assertEqual(self.prepare_calls, 0)

    @unittest.skipIf(os.name == 'nt', 'symlink creation may require host privileges')
    def test_final_or_parent_symlink_replacement_rejected(self):
        other = self.root / 'other-weights'
        other.write_bytes(self.original)
        def link():
            self.model.unlink()
            self.model.symlink_to(other)
        with self.after_first_hash(link), self.assertRaises(ValueError):
            self.validate()
        self.model.unlink()
        self.model.write_bytes(self.original)
        def parent_link():
            moved = self.root / 'moved-model'
            self.base.rename(moved)
            self.base.symlink_to(moved, target_is_directory=True)
        with self.after_first_hash(parent_link), self.assertRaises(ValueError):
            self.validate()
        self.assertEqual(self.prepare_calls, 0)

    def test_concurrent_writer_during_full_hash_rejected(self):
        original = hashlib.file_digest
        started = threading.Event()
        done = threading.Event()
        errors = []
        def writer():
            if not started.wait(2):
                errors.append('hash was not reached')
            else:
                # Keep the bytes identical so the fd stamp, rather than a
                # mismatched digest, must catch the overlapping write.
                self.model.write_bytes(self.original)
            done.set()
        thread = threading.Thread(target=writer)
        thread.start()
        def overlap(stream, *args, **kwargs):
            info = os.fstat(stream.fileno())
            if info.st_ino != self.model.stat().st_ino:
                return original(stream, *args, **kwargs)
            class OverlappingReader:
                signalled = False
                def readable(self):return stream.readable()
                def readinto(self, buffer):
                    size = stream.readinto(buffer)
                    if size and not self.signalled:
                        self.signalled = True
                        started.set()
                        if not done.wait(2):raise AssertionError('writer did not finish')
                    return size
            return original(OverlappingReader(), *args, **kwargs)
        try:
            with patch.object(hashlib, 'file_digest', side_effect=overlap):
                with self.assertRaisesRegex(ValueError, 'MODEL_CHANGED'):
                    self.validate()
        finally:
            started.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(self.prepare_calls, 0)

    def test_hash_error_or_cancel_closes_fd_and_retry_reads_again(self):
        original = hashlib.file_digest
        for error in (OSError('synthetic-read-error'), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__):
                opened = []
                def fail(stream, *args, **kwargs):
                    info = os.fstat(stream.fileno())
                    if info.st_ino == self.model.stat().st_ino:
                        opened.append(stream.fileno())
                        raise error
                    return original(stream, *args, **kwargs)
                with patch.object(hashlib, 'file_digest', side_effect=fail):
                    with self.assertRaises(type(error)):
                        self.validate()
                self.assertEqual(len(opened), 1)
                with self.assertRaises(OSError):
                    os.fstat(opened[0])
                self.assertEqual(self.model_hashes(self.validate), [len(self.original)])
        self.assertEqual(self.prepare_calls, 2)

    def test_opened_descriptor_must_match_preopen_identity(self):
        original = os.open
        def swap(path, *args, **kwargs):
            if path == self.model:
                replacement = self.base / 'replacement'
                replacement.write_bytes(self.original)
                replacement.replace(self.model)
            return original(path, *args, **kwargs)
        with patch.object(runtime.os, 'open', side_effect=swap):
            with self.assertRaisesRegex(ValueError, 'MODEL_CHANGED'):
                self.validate()
        self.assertEqual(self.prepare_calls, 0)

    def test_cancel_or_error_after_hash_never_leases_digest_to_retry(self):
        for error in (KeyboardInterrupt(), RuntimeError('synthetic-failure')):
            with self.subTest(error=type(error).__name__):
                def fail():raise error
                def failed_then_retry():
                    with self.after_first_hash(fail), self.assertRaises(type(error)):
                        self.validate()
                    self.validate()
                self.assertEqual(self.model_hashes(failed_then_retry), [len(self.original)] * 2)
        self.assertEqual(self.prepare_calls, 2)

    def test_native_or_converter_pin_failure_remains_fatal(self):
        for path in (self.native, self.converter.parent / 'source.py'):
            with self.subTest(path=path.name):
                original = path.read_bytes()
                path.write_bytes(b'corrupt')
                with self.assertRaisesRegex(ValueError, 'RUNTIME_SOURCE_CHANGED'):
                    self.validate()
                path.write_bytes(original)
        self.assertEqual(self.prepare_calls, 0)

    def test_changed_derivative_manifest_or_content_is_still_checked_every_request(self):
        for path in (self.derivative / 'gguf/VoxCPM2-BaseLM-F16.gguf', self.derivative / 'conversion.json'):
            with self.subTest(path=path.name):
                self.validate()
                original = path.read_bytes()
                path.write_bytes(b'corrupt')
                with self.assertRaisesRegex(ValueError, 'GGUF_CACHE_CHANGED'):
                    self.validate()
                path.write_bytes(original)

    def test_changed_package_or_policy_cache_identity_does_not_reuse_old_derivative(self):
        self.validate()
        for key in ('packageSha256', 'adapterSha256'):
            original = self.selected[key]
            self.selected[key] = 'changed'
            with self.assertRaisesRegex(ValueError, 'GGUF_CACHE_CHANGED'):
                self.validate()
            self.selected[key] = original
        self.policy['converterFiles'] = {}
        self.write_policy_and_receipt()
        with self.assertRaisesRegex(ValueError, 'GGUF_CACHE_CHANGED'):
            self.validate()


if __name__ == '__main__':
    unittest.main()
