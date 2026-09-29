import fcntl
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.production.lightsail import refresh_backup_runtime as runtime


class BackupRuntimeRefreshTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.source, self.target, self.lock = root / "source", root / "target", root / "job.lock"
        self.source.mkdir()
        self.target.mkdir()
        self.lock.touch(mode=0o600)
        self.originals = {name: b"# previous reviewed backup source\n" for name in runtime.FILES}
        self.hashes = {}
        for name in runtime.FILES:
            content = (Path("scripts/production") / name).read_bytes()
            (self.source / name).write_bytes(content)
            self.hashes[name] = hashlib.sha256(content).hexdigest()
            (self.target / name).write_bytes(self.originals[name])

    def refresh(self):
        return runtime.refresh(self.source, self.target, self.lock, self.hashes)

    def assert_originals(self):
        for name, content in self.originals.items():
            self.assertEqual((self.target / name).read_bytes(), content)

    def test_installs_pinned_files_retains_previous_versions_and_is_idempotent(self):
        self.assertTrue(self.refresh())
        for name, original in self.originals.items():
            self.assertEqual((self.target / name).read_bytes(), (self.source / name).read_bytes())
            retained = self.target / "backup-runtime-previous" / (name + "." + hashlib.sha256(original).hexdigest())
            self.assertEqual(retained.read_bytes(), original)
            self.assertEqual((self.target / name).stat().st_mode & 0o777, 0o644)
        self.assertFalse(self.refresh())

    def test_digest_mismatch_changes_nothing(self):
        (self.source / "lightsail_backup.py").write_text("unreviewed source")
        with self.assertRaises(ValueError):
            self.refresh()
        self.assert_originals()

    def test_missing_dependency_is_installed_without_touching_legacy_modules(self):
        (self.target / "private_files.py").unlink()
        legacy = self.target / "transfer.py"
        legacy.write_text("# retained legacy dependency\n")
        self.assertTrue(self.refresh())
        self.assertEqual(legacy.read_text(), "# retained legacy dependency\n")
        self.assertEqual((self.target / "private_files.py").read_bytes(), (self.source / "private_files.py").read_bytes())

    def test_symlink_target_is_rejected_without_following_it(self):
        path = self.target / "private_files.py"
        path.unlink()
        path.symlink_to(self.target / "absent.py")
        with self.assertRaises(ValueError):
            self.refresh()
        self.assertTrue(path.is_symlink())
        self.assertFalse((self.target / "absent.py").exists())

    def test_running_backup_blocks_refresh_without_modifying_sources(self):
        with self.lock.open("r+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.refresh()
        self.assert_originals()

    def test_second_file_install_failure_restores_first_file(self):
        write = runtime.atomic_write

        def fail_consumer(path, content):
            if path.name == "lightsail_backup.py":
                raise OSError("synthetic install failure")
            write(path, content)

        with patch.object(runtime, "atomic_write", side_effect=fail_consumer):
            with self.assertRaises(OSError):
                self.refresh()
        self.assert_originals()


if __name__ == "__main__":
    unittest.main()
