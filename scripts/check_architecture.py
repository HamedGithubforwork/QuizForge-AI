#!/usr/bin/env python3
"""Small dependency-boundary checks for QuizForge.

This is intentionally dependency-free so it can run early in CI. It protects only
boundaries that are already true and valuable today; extend it when a new durable
boundary is introduced rather than encoding speculative architecture.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

PURE_BACKEND_MODULES = (
    Path("backend/spaced_repetition.py"),
    Path("backend/quiz_validation.py"),
)

FORBIDDEN_BACKEND_IMPORT_ROOTS = {
    "fastapi",
    "psycopg",
    "psycopg_pool",
    "redis",
    "boto3",
    "botocore",
}

ISOLATED_LOCAL_AI_MODULES = (
    Path("desktop/src/local-model-store.cjs"),
    Path("desktop/src/local-runtime.cjs"),
)

FORBIDDEN_LOCAL_AI_IMPORTS = {
    "electron",
    "./main.cjs",
    "./native-bridge.cjs",
    "./preload.cjs",
}

_JS_IMPORT_RE = re.compile(
    r"""(?:require\s*\(\s*|\bfrom\s+|import\s*\(\s*)['\"]([^'\"]+)['\"]"""
)


def python_import_roots(source: str) -> set[str]:
    tree = ast.parse(source)
    roots: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".", 1)[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            roots.add(node.module.split(".", 1)[0])

    return roots


def javascript_specifiers(source: str) -> set[str]:
    return set(_JS_IMPORT_RE.findall(source))


def _require_file(root: Path, relative: Path, violations: list[str]) -> Path | None:
    path = root / relative
    if not path.is_file():
        violations.append(f"required architecture target is missing: {relative}")
        return None
    return path


def check_repository(root: Path = ROOT) -> list[str]:
    violations: list[str] = []

    if not (root / "ARCHITECTURE.md").is_file():
        violations.append("ARCHITECTURE.md is missing")

    for relative in PURE_BACKEND_MODULES:
        path = _require_file(root, relative, violations)
        if path is None:
            continue

        imports = python_import_roots(path.read_text(encoding="utf-8"))
        forbidden = sorted(imports & FORBIDDEN_BACKEND_IMPORT_ROOTS)
        if forbidden:
            violations.append(
                f"{relative} crosses the pure-domain boundary via: "
                + ", ".join(forbidden)
            )

    for relative in ISOLATED_LOCAL_AI_MODULES:
        path = _require_file(root, relative, violations)
        if path is None:
            continue

        imports = javascript_specifiers(path.read_text(encoding="utf-8"))
        forbidden = sorted(imports & FORBIDDEN_LOCAL_AI_IMPORTS)
        if forbidden:
            violations.append(
                f"{relative} crosses the Local AI isolation boundary via: "
                + ", ".join(forbidden)
            )

    return violations


def main() -> int:
    violations = check_repository()
    if violations:
        print("Architecture checks failed:")
        for violation in violations:
            print(f"- {violation}")
        return 1

    print(
        "Architecture checks passed: pure backend rules and Local AI "
        "runtime/storage isolation are intact."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
