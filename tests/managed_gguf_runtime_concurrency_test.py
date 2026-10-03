"""CPU-only real-file/FD regressions for managed admission. No TTS/GPU loads."""
import concurrent.futures
import contextlib
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import threading
from threading import local as thread_local
import unittest
from unittest.mock import patch

VOICE = Path(__file__).resolve().parents[1] / 'electron/voice'
sys.path.insert(0, str(VOICE))
import managed_gguf_runtime as managed


class RollingHashTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.root = Path(self.scratch.name).resolve()
        fingerprint = hashlib.sha256(b'private CPU fixture').hexdigest()
        self.directory = self.root/'components'/'shared'/fingerprint
        self.directory.mkdir(parents=True)
        self.paths = []
        self.component = dict(id='shared', archive=dict(bytes=100, sha256=fingerprint, format='zip'), files={})
        for index in range(8):
            raw = bytes([index + 1]) * 32768
            name = 'file-%d.dat' % index
            target = self.directory/name
            target.write_bytes(raw)
            self.paths.append(target)
            self.component['files'][name] = dict(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        self.real_hash = managed.full_hash
        self.real_digest = managed.hashlib.file_digest
        self.real_open = managed.os.open
        self.real_fdopen = managed.os.fdopen
        self.lock = threading.Lock()
        self.release = threading.Event()
        self.ready = threading.Event()
        self.hash_context = thread_local()
        self.started = []
        self.finished = []
        self.fds = []
        self.active = 0
        self.peak_active = 0
        self.peak_fds = 0
        self.result = []
        self.error = []
        self.done = threading.Event()

    def tearDown(self):
        self.release.set()
        if hasattr(self, 'runner'):
            self.runner.join(5)
            self.assertFalse(self.runner.is_alive())
        self.scratch.cleanup()

    def observed_hash(self, path, record):
        with self.lock:
            index = len(self.started)
            self.started.append(path.name)
            self.active += 1
            self.peak_active = max(self.peak_active, self.active)
        self.hash_context.index = index
        try:
            return self.real_hash(path, record)
        finally:
            with self.lock:
                self.active -= 1
                self.finished.append(path.name)

    def observed_open(self, path, flags, *args, **kwargs):
        fd = self.real_open(path, flags, *args, **kwargs)
        with self.lock:
            self.fds.append(fd)
            alive = 0
            for item in set(self.fds):
                try:
                    os.fstat(item)
                    alive += 1
                except OSError:
                    pass
            self.peak_fds = max(self.peak_fds, alive)
        return fd

    def patches(self, digest=None):
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(managed, 'full_hash', side_effect=self.observed_hash))
        stack.enter_context(patch.object(managed.os, 'open', side_effect=self.observed_open))
        if digest is not None:
            stack.enter_context(patch.object(managed.hashlib, 'file_digest', side_effect=digest))
        return stack

    def run_background(self):
        def run():
            try:
                self.result.append(managed.verify_component(self.root, self.component))
            except BaseException as error:
                self.error.append(error)
            finally:
                self.done.set()
        self.runner = threading.Thread(target=run, name='private-admission-coordinator')
        self.runner.start()

    def assert_closed(self):
        self.assertEqual(self.active, 0)
        self.assertEqual(sorted(self.finished), sorted(self.started))
        for fd in set(self.fds):
            with self.assertRaises(OSError):
                os.fstat(fd)

    def drain_scenario(self, kind):
        barrier = threading.Barrier(4, timeout=5)
        first_closed = threading.Event()
        def digest(source, algorithm):
            index = self.hash_context.index
            if index < 4:
                barrier.wait()
                if index == 0:
                    if kind == 'read':
                        raise OSError('private injected read failure')
                    value = self.real_digest(source, algorithm)
                    if kind == 'wrong-sha':
                        return hashlib.sha256(b'wrong full digest')
                    return value
                self.ready.set()
                if not self.release.wait(5):
                    raise RuntimeError('fixture drain timeout')
            return self.real_digest(source, algorithm)
        original = self.observed_hash
        def hash_and_notify(path, record):
            try:
                return original(path, record)
            finally:
                if getattr(self.hash_context, 'index', None) == 0:
                    first_closed.set()
        with self.patches(digest), patch.object(managed, 'full_hash', side_effect=hash_and_notify):
            self.run_background()
            self.assertTrue(self.ready.wait(5))
            self.assertTrue(first_closed.wait(5))
            self.assertFalse(self.done.wait(.05), 'returned before the other actual FDs closed')
            self.assertEqual(len(self.started), 4, 'refilled after first error')
            self.release.set()
            self.assertTrue(self.done.wait(5))
        self.assertEqual(self.result, [])
        self.assertEqual(len(self.error), 1)
        self.assertIsInstance(self.error[0], ValueError)
        self.assertEqual(str(self.error[0]), managed.ERROR)
        self.assert_closed()

    def test_all_eight_full_hashes_bound_four_real_fds_and_return_after_close(self):
        barrier = threading.Barrier(4, timeout=5)
        def digest(source, algorithm):
            if self.hash_context.index < 4:
                barrier.wait()
            return self.real_digest(source, algorithm)
        with self.patches(digest):
            value = managed.verify_component(self.root, self.component)
        self.assertEqual(value, self.directory)
        self.assertEqual(set(self.started), set(self.component['files']))
        self.assertEqual(len(self.started), 8)
        self.assertEqual(self.peak_active, 4)
        self.assertEqual(self.peak_fds, 4)
        self.assert_closed()

    def test_wrong_full_sha_drains_other_real_fds_before_public_error(self):
        self.drain_scenario('wrong-sha')

    def test_digest_read_failure_drains_before_public_error(self):
        self.drain_scenario('read')

    def test_close_failure_after_actual_close_drains_and_rejects(self):
        # Real fdopen owns/closes the FD; only its error is injected afterwards.
        class CloseFailure:
            def __init__(self, source, index): self.source, self.index = source, index
            def __enter__(self): return self.source.__enter__()
            def __exit__(self, *args):
                value = self.source.__exit__(*args)
                if self.index == 0: raise OSError('private injected close failure')
                return value
        def fdopen(fd, *args, **kwargs):
            return CloseFailure(self.real_fdopen(fd, *args, **kwargs), self.hash_context.index)
        with patch.object(managed.os, 'fdopen', side_effect=fdopen):
            self.drain_scenario('close')

    def test_open_failure_rejects_and_leaves_no_real_fd(self):
        def opened(path, flags, *args, **kwargs):
            if Path(path).name == 'file-0.dat': raise OSError('private injected open failure')
            return self.observed_open(path, flags, *args, **kwargs)
        with self.patches(), patch.object(managed.os, 'open', side_effect=opened):
            with self.assertRaisesRegex(ValueError, managed.ERROR):
                managed.verify_component(self.root, self.component)
        self.assert_closed()

    def test_traversal_failure_after_started_hashes_drains_before_error(self):
        original = Path.rglob
        def traversal(path, pattern):
            if path == self.directory:
                for entry in self.paths[:4]: yield entry
                raise OSError('private injected traversal failure')
            else:
                yield from original(path, pattern)
        with patch.object(Path, 'rglob', traversal):
            self.drain_scenario('traversal')

    def test_ordinary_failure_after_started_hashes_drains_before_error(self):
        original = managed.ordinary
        original_rglob = Path.rglob
        def ordinary(path, directory=False):
            if Path(path) == self.paths[4]: raise OSError('private injected path failure')
            return original(path, directory)
        def traversal(path, pattern):
            return iter(self.paths) if path == self.directory else original_rglob(path, pattern)
        with patch.object(managed, 'ordinary', side_effect=ordinary), patch.object(Path, 'rglob', traversal):
            self.drain_scenario('ordinary')

    def test_missing_extra_and_hardlink_are_rejected(self):
        target = self.paths[-1]
        raw = target.read_bytes()
        target.unlink()
        with self.assertRaisesRegex(ValueError, managed.ERROR): managed.verify_component(self.root, self.component)
        target.write_bytes(raw)
        extra = self.directory/'extra.dat'; extra.write_bytes(b'extra')
        with self.assertRaisesRegex(ValueError, managed.ERROR): managed.verify_component(self.root, self.component)
        extra.unlink(); target.unlink(); os.link(self.paths[0], target)
        with self.assertRaisesRegex(ValueError, managed.ERROR): managed.verify_component(self.root, self.component)

    def test_symlink_is_rejected_when_creation_is_permitted(self):
        target = self.paths[-1]
        target.unlink()
        try: target.symlink_to(self.paths[0])
        except (OSError, NotImplementedError): self.skipTest('host does not permit fixture symlink creation')
        with self.assertRaisesRegex(ValueError, managed.ERROR): managed.verify_component(self.root, self.component)

    def test_mid_read_same_size_mutation_is_rejected_after_real_close(self):
        changed = False
        def digest(source, algorithm):
            nonlocal changed
            value = self.real_digest(source, algorithm)
            with self.lock:
                if not changed:
                    changed = True
                    with open(self.directory/self.started[self.hash_context.index], 'r+b') as writer:
                        writer.write(b'changed!'); writer.flush(); os.fsync(writer.fileno())
            return value
        with self.patches(digest):
            with self.assertRaisesRegex(ValueError, managed.ERROR): managed.verify_component(self.root, self.component)
        self.assert_closed()

    def test_scheduler_creation_failure_has_same_error_and_starts_no_hash(self):
        with self.patches(), patch.object(concurrent.futures, 'ThreadPoolExecutor', side_effect=RuntimeError('create')):
            with self.assertRaisesRegex(ValueError, managed.ERROR): managed.verify_component(self.root, self.component)
        self.assertEqual(self.started, [])
        self.assert_closed()

    def scheduler_drain(self, kind):
        entered = threading.Barrier(5, timeout=5)
        def digest(source, algorithm):
            if self.hash_context.index < 4:
                entered.wait()
                if not self.release.wait(5): raise RuntimeError('fixture timeout')
            return self.real_digest(source, algorithm)
        def waited(*args, **kwargs):
            entered.wait()
            self.ready.set()
            if kind == 'cancel': raise KeyboardInterrupt('private admission interruption')
            raise RuntimeError('private scheduler wait failure')
        with self.patches(digest), patch.object(concurrent.futures, 'wait', side_effect=waited):
            self.run_background()
            self.assertTrue(self.ready.wait(5))
            self.assertFalse(self.done.wait(.05))
            self.assertEqual(len(self.started), 4)
            self.release.set()
            self.assertTrue(self.done.wait(5))
        self.assertEqual(self.result, [])
        self.assertIsInstance(self.error[0], KeyboardInterrupt if kind == 'cancel' else ValueError)
        self.assert_closed()

    def test_scheduler_wait_failure_drains_before_public_error(self):
        self.scheduler_drain('wait')

    def test_admission_interruption_drains_without_claiming_cooperative_process_cancel(self):
        self.scheduler_drain('cancel')

    def test_submit_failure_drains_real_jobs_before_public_error(self):
        original = concurrent.futures.ThreadPoolExecutor.submit
        count = 0
        def submit(executor, *args, **kwargs):
            nonlocal count
            count += 1
            if count == 5: raise RuntimeError('private submit failure')
            return original(executor, *args, **kwargs)
        with patch.object(concurrent.futures.ThreadPoolExecutor, 'submit', submit):
            self.drain_scenario('submit')

    def test_shutdown_failure_drains_futures_retries_cleanup_and_rejects(self):
        original = concurrent.futures.ThreadPoolExecutor.shutdown
        count = 0
        def shutdown(executor, *args, **kwargs):
            nonlocal count
            count += 1
            if count == 1: raise RuntimeError('private shutdown failure')
            return original(executor, *args, **kwargs)
        with self.patches(), patch.object(concurrent.futures.ThreadPoolExecutor, 'shutdown', shutdown):
            with self.assertRaisesRegex(ValueError, managed.ERROR): managed.verify_component(self.root, self.component)
        self.assertEqual(count, 2)
        self.assert_closed()

    def test_shutdown_failure_with_active_reads_still_drains_before_error(self):
        original = concurrent.futures.ThreadPoolExecutor.shutdown
        count = 0
        def shutdown(executor, *args, **kwargs):
            nonlocal count
            count += 1
            if count == 1: raise RuntimeError('private shutdown with active reads')
            return original(executor, *args, **kwargs)
        with patch.object(concurrent.futures.ThreadPoolExecutor, 'shutdown', shutdown):
            self.scheduler_drain('wait')
        self.assertEqual(count, 2)

    def test_completed_success_and_error_batch_never_refills(self):
        original = concurrent.futures.wait
        def wait_all(futures, **kwargs):
            return original(futures, return_when=concurrent.futures.ALL_COMPLETED)
        def digest(source, algorithm):
            result = self.real_digest(source, algorithm)
            return hashlib.sha256(b'wrong full digest') if self.hash_context.index == 0 else result
        with self.patches(digest), patch.object(concurrent.futures, 'wait', side_effect=wait_all):
            with self.assertRaisesRegex(ValueError, managed.ERROR):
                managed.verify_component(self.root, self.component)
        self.assertEqual(len(self.started), 4)
        self.assert_closed()

    def test_manual_path_does_not_import_scheduler(self):
        real_import = __import__
        def guarded(name, *args, **kwargs):
            if name == 'concurrent.futures': raise AssertionError('manual scheduler import')
            return real_import(name, *args, **kwargs)
        with patch('builtins.__import__', side_effect=guarded):
            self.assertIsNone(managed.admit(None, {}, 'qwen-cuda', Path('manual')))


if __name__ == '__main__':
    unittest.main()
