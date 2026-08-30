from pathlib import Path
import re


BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent


def _normalized_name(value: str):
    return re.match(
        r"^[A-Za-z0-9_.-]+",
        value.strip(),
    ).group(0).replace("_", "-").lower()


def _lock_versions(filename: str):
    versions = {}

    for raw_line in (
        BACKEND_DIR / filename
    ).read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()

        if not line or line.startswith("#"):
            continue

        assert "==" in line, line
        name, version = line.split("==", 1)
        versions[_normalized_name(name)] = version

    return versions


def _direct_requirement_names(filename: str):
    names = set()

    for raw_line in (
        BACKEND_DIR / filename
    ).read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()

        if (
            not line
            or line.startswith("#")
            or line.startswith("-r ")
        ):
            continue

        names.add(_normalized_name(line))

    return names


def test_runtime_direct_dependencies_are_locked():
    runtime_lock = _lock_versions(
        "requirements.lock"
    )
    direct_runtime = _direct_requirement_names(
        "requirements.in"
    )

    assert direct_runtime <= runtime_lock.keys()


def test_dev_lock_preserves_runtime_versions():
    runtime_lock = _lock_versions(
        "requirements.lock"
    )
    dev_lock = _lock_versions(
        "requirements-dev.lock"
    )

    for name, version in runtime_lock.items():
        assert dev_lock.get(name) == version

    direct_dev = _direct_requirement_names(
        "requirements-dev.in"
    )
    assert direct_dev <= dev_lock.keys()


def test_install_entrypoints_apply_constraints():
    runtime_entrypoint = (
        BACKEND_DIR / "requirements.txt"
    ).read_text(encoding="utf-8")
    dev_entrypoint = (
        BACKEND_DIR / "requirements-dev.txt"
    ).read_text(encoding="utf-8")

    assert "-c requirements.lock" in runtime_entrypoint
    assert "-r requirements.in" in runtime_entrypoint
    assert "-c requirements-dev.lock" in dev_entrypoint
    assert "-r requirements-dev.in" in dev_entrypoint


def test_python_version_is_pinned():
    assert (
        REPO_ROOT / ".python-version"
    ).read_text(encoding="utf-8").strip() == "3.11.16"
