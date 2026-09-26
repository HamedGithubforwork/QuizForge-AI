"""Private bounded-file helpers for production credentials and artifacts."""
import os
from pathlib import Path
import stat


def private_write(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as file:
        file.write(data)


def private_read(path, maximum):
    candidate = Path(path)
    descriptor = os.open(candidate, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as file:
        info = os.fstat(file.fileno())
        credentials_directory = os.environ.get("CREDENTIALS_DIRECTORY")
        systemd_credential = False
        if credentials_directory:
            root = Path(credentials_directory)
            systemd_credential = root.is_absolute() and candidate.is_absolute() and candidate.parent == root
        bad_mode = info.st_mode & (0o022 if systemd_credential else 0o077)
        if not stat.S_ISREG(info.st_mode) or bad_mode or info.st_size > maximum:
            raise ValueError("Input must be a private bounded regular file")
        return file.read(maximum + 1)
