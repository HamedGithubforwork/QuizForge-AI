#!/usr/bin/env python3
"""Early, dependency-free architecture checks for established backend boundaries.

Follow statically declared local Python dependencies too, so a new helper cannot
quietly reconnect domain code to HTTP or persistence. This is not a security
sandbox; syntax-aware JavaScript/TypeScript enforcement runs separately in CI.
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PURE_BACKEND_MODULES = tuple(Path("backend") / name for name in (
    "spaced_repetition.py",
    "quiz_validation.py",
    "review_service.py",
    "lifetime_entitlement_fulfillment.py",
))
FORBIDDEN_BACKEND_IMPORT_ROOTS = {
    "fastapi", "starlette", "psycopg", "psycopg_pool", "redis", "boto3", "botocore",
    "deck_postgres", "history_database", "history_postgres", "decks",
    "app_shared", "main", "application",
}
ISOLATED_LOCAL_AI_MODULES = tuple(Path("desktop/src") / name for name in (
    "local-model-store.cjs", "local-runtime.cjs",
))
FORBIDDEN_LOCAL_AI_IMPORTS = {"electron", "./main.cjs", "./native-bridge.cjs", "./preload.cjs"}
_JS_IMPORT_RE = re.compile(r'''(?:require\s*\(\s*|\bfrom\s+|import\s*\(\s*)['"]([^'"]+)['"]''')


def python_imports(source: str, relative: Path) -> set[str]:
    """Resolve import spellings relative to the repository, without executing code."""
    result: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            result.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                package = list(relative.parent.parts)
                if node.level > len(package):
                    raise ValueError("relative import leaves the repository")
                package = package[:len(package) - node.level + 1]
                module = ".".join(package + (node.module or "").split("."))
            else:
                module = node.module or ""
            module = module.rstrip(".")
            if module:
                result.add(module)
            for alias in node.names:
                if alias.name != "*":
                    result.add(".".join(filter(None, (module, alias.name))))
    return result


def javascript_specifiers(source: str) -> set[str]:
    # Preserve the existing cheap check. The required AST job is authoritative
    # for normalized imports, re-exports, dynamic imports and public entry points.
    return set(_JS_IMPORT_RE.findall(source))


def _require_file(root: Path, relative: Path, violations: list[str]) -> Path | None:
    filename = root / relative
    if not filename.is_file() or filename.is_symlink():
        violations.append(f"required architecture target is missing or unsafe: {relative}")
        return None
    return filename


def _local_modules(root: Path, module: str) -> list[Path]:
    parts = module.split(".")
    if parts[0] == "backend":
        parts = parts[1:]
    result = []
    # Include package initializers as well as an imported child module.
    for count in range(1, len(parts) + 1):
        base = Path("backend").joinpath(*parts[:count])
        for candidate in (base.with_suffix(".py"), base / "__init__.py"):
            if (root / candidate).is_file():
                result.append(candidate)
    return result


def _check_domain(root: Path, origin: Path, violations: list[str]) -> None:
    visited: set[Path] = set()

    def visit(relative: Path, chain: tuple[Path, ...]) -> None:
        if relative in visited:
            return
        visited.add(relative)
        filename = _require_file(root, relative, violations)
        if filename is None:
            return
        try:
            modules = python_imports(filename.read_text(encoding="utf-8"), relative)
        except (SyntaxError, ValueError, UnicodeError) as error:
            violations.append(f"{relative}: cannot inspect domain imports ({type(error).__name__})")
            return
        for module in sorted(modules):
            parts = module.split(".")
            first = parts[1] if parts[0] == "backend" and len(parts) > 1 else parts[0]
            if first in FORBIDDEN_BACKEND_IMPORT_ROOTS:
                route = " -> ".join(map(str, (*chain, relative)))
                violations.append(f"{origin} crosses the pure-domain boundary via {route}: {module}")
                continue
            for target in _local_modules(root, module):
                visit(target, (*chain, relative))

    visit(origin, ())


def check_repository(root: Path = ROOT) -> list[str]:
    violations: list[str] = []
    if not (root / "ARCHITECTURE.md").is_file():
        violations.append("ARCHITECTURE.md is missing")
    for relative in PURE_BACKEND_MODULES:
        _check_domain(root, relative, violations)
    for relative in ISOLATED_LOCAL_AI_MODULES:
        filename = _require_file(root, relative, violations)
        if filename is None:
            continue
        forbidden = sorted(javascript_specifiers(filename.read_text(encoding="utf-8")) & FORBIDDEN_LOCAL_AI_IMPORTS)
        if forbidden:
            violations.append(f"{relative} crosses the Local AI isolation boundary via: " + ", ".join(forbidden))
    return sorted(set(violations))


def main() -> int:
    violations = check_repository()
    if violations:
        print("Architecture checks failed:\n" + "\n".join(f"- {item}" for item in violations))
        return 1
    print("Architecture checks passed: backend dependency graph and Local AI isolation.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
