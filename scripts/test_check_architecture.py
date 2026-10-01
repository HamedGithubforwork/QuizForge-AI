from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from check_architecture import check_repository


class ArchitectureCheckTests(unittest.TestCase):
    def make_repo(self, *, spaced="from datetime import datetime\n", validation="import math\n",
                  review="from spaced_repetition import schedule_review\n", store="require('node:fs')\n",
                  runtime="require('node:http')\n", extra=None):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        files = {"ARCHITECTURE.md": "# Architecture\n", "backend/spaced_repetition.py": spaced,
                 "backend/quiz_validation.py": validation, "backend/review_service.py": review,
                 "desktop/src/local-model-store.cjs": store, "desktop/src/local-runtime.cjs": runtime}
        files.update(extra or {})
        for name, source in files.items():
            filename = root / name
            filename.parent.mkdir(parents=True, exist_ok=True)
            filename.write_text(source, encoding="utf-8")
        return root

    def test_current_boundaries_pass(self):
        self.assertEqual(check_repository(self.make_repo()), [])

    def test_framework_and_database_dependencies_are_rejected(self):
        for source, target in [("from fastapi import HTTPException", "fastapi"),
                               ("import psycopg", "psycopg"), ("from backend import deck_postgres", "deck_postgres"),
                               ("from . import decks", "decks")]:
            with self.subTest(source=source):
                self.assertTrue(any(target in item for item in check_repository(self.make_repo(review=source))))

    def test_new_helper_cannot_hide_a_database_dependency(self):
        root = self.make_repo(review="from helper import decide", extra={"backend/helper.py": "import psycopg"})
        violations = check_repository(root)
        self.assertTrue(any("helper.py" in item and "psycopg" in item for item in violations))

    def test_relative_helper_cannot_hide_http_dependency(self):
        root = self.make_repo(review="from . import helper", extra={"backend/helper.py": "from fastapi import Request"})
        self.assertTrue(any("fastapi" in item for item in check_repository(root)))

    def test_package_initializers_are_checked(self):
        root = self.make_repo(review="from local_package.rules import decide", extra={
            "backend/local_package/__init__.py": "import redis",
            "backend/local_package/rules.py": "def decide(): return True"})
        self.assertTrue(any("redis" in item for item in check_repository(root)))

    def test_safe_import_cycle_terminates(self):
        root = self.make_repo(review="import helper", extra={"backend/helper.py": "import review_service"})
        self.assertEqual(check_repository(root), [])

    def test_quoted_import_and_comments_are_not_python_dependencies(self):
        root = self.make_repo(review='# import psycopg\n"from fastapi import Request"\n')
        self.assertEqual(check_repository(root), [])

    def test_missing_domain_module_fails(self):
        root = self.make_repo()
        (root / "backend/review_service.py").unlink()
        self.assertTrue(any("review_service.py" in item for item in check_repository(root)))

    def test_invalid_python_fails_closed(self):
        root = self.make_repo(review="from = broken")
        self.assertTrue(any("cannot inspect" in item for item in check_repository(root)))

    def test_electron_in_runtime_is_rejected(self):
        root = self.make_repo(runtime="const { app } = require('electron')")
        self.assertTrue(any("electron" in item for item in check_repository(root)))


if __name__ == "__main__":
    unittest.main()
