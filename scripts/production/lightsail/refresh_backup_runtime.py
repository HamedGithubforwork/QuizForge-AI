"""Install the pinned backup schema reader while retaining its previous version."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

FILES = ("private_files.py", "lightsail_backup.py")


def regular_bytes(path: Path) -> bytes:
    if not stat.S_ISREG(path.lstat().st_mode) or path.stat().st_size > 128 * 1024:
        raise ValueError("Expected bounded regular backup source")
    return path.read_bytes()


def atomic_write(path: Path, content: bytes) -> None:
    name = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            name = handle.name
            handle.write(content)
            handle.flush()
            os.fchmod(handle.fileno(), 0o644)
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        if name:
            Path(name).unlink(missing_ok=True)


def refresh(source: Path, target: Path, lock: Path, hashes: dict) -> bool:
    if set(hashes) != set(FILES) or target.is_symlink() or not target.is_dir():
        raise ValueError("Unexpected backup runtime contract")
    candidates = {name: regular_bytes(source / name) for name in FILES}
    for name, content in candidates.items():
        if hashlib.sha256(content).hexdigest() != hashes[name]:
            raise ValueError("Pinned backup source digest mismatch")
        compile(content, name, "exec")

    # Reuse the existing backup job lock. Never create or change its ownership.
    descriptor = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "r+b") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError("Expected regular backup job lock")
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if any((target / name).is_symlink() for name in FILES):
            raise ValueError("Backup runtime must not contain symlinks")
        originals = {
            name: regular_bytes(target / name) if (target / name).exists() else None
            for name in FILES
        }
        if originals["lightsail_backup.py"] is None:
            raise ValueError("Existing backup runtime is required")
        if originals == candidates:
            return False
        retained = target / "backup-runtime-previous"
        retained.mkdir(mode=0o700, exist_ok=True)
        if retained.is_symlink() or not retained.is_dir():
            raise ValueError("Invalid retained backup runtime directory")
        for name, content in originals.items():
            if content is not None:
                path = retained / (name + "." + hashlib.sha256(content).hexdigest())
                if path.exists():
                    if regular_bytes(path) != content:
                        raise ValueError("Retained backup source mismatch")
                else:
                    with path.open("xb") as output:
                        output.write(content)
        changed = []
        try:
            # Install the backwards-compatible dependency before its consumer.
            for name in FILES:
                atomic_write(target / name, candidates[name])
                changed.append(name)
        except Exception:
            for name in reversed(changed):
                if originals[name] is None:
                    (target / name).unlink()
                else:
                    atomic_write(target / name, originals[name])
            raise
    return True


if __name__ == "__main__":
    manifest = json.loads(Path(sys.argv[2]).read_text())
    changed = refresh(
        Path(sys.argv[1]), Path("/opt/quizforge/operations"),
        Path("/var/lib/quizforge-backup/job.lock"), manifest["backup_runtime_sha256"],
    )
    print("QF_BACKUP_RUNTIME_REFRESHED=" + str(changed).lower())
