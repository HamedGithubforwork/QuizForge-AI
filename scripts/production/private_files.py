"""Private bounded-file helpers for production credentials and artifacts."""
import os
import stat


def private_write(path, data):
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    with os.fdopen(descriptor, "wb") as file:
        file.write(data)


def private_read(path, maximum):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as file:
        info = os.fstat(file.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_mode & 0o077
            or info.st_size > maximum
        ):
            raise ValueError(
                "Input must be a private bounded regular file"
            )
        return file.read(maximum + 1)
