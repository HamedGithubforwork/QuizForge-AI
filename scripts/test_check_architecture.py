from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from check_architecture import check_repository


GOOD_SPACED = "from datetime import datetime\n"
GOOD_VALIDATION = "import math\n"
GOOD_REVIEW = "from datetime import datetime\n"
GOOD_STORE = "'use strict'\nconst fs = require('node:fs/promises')\n"
GOOD_RUNTIME = "'use strict'\nconst http = require('node:http')\n"


class ArchitectureCheckTests(unittest.TestCase):
    def make_repo(
        self,
        *,
        spaced: str = GOOD_SPACED,
        validation: str = GOOD_VALIDATION,
        review: str = GOOD_REVIEW,
        store: str = GOOD_STORE,
        runtime: str = GOOD_RUNTIME,
    ):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        (root / "backend").mkdir()
        (root / "desktop/src").mkdir(parents=True)
        (root / "ARCHITECTURE.md").write_text("# Architecture\n", encoding="utf-8")
        (root / "backend/spaced_repetition.py").write_text(spaced, encoding="utf-8")
        (root / "backend/quiz_validation.py").write_text(validation, encoding="utf-8")
        (root / "backend/review_service.py").write_text(review, encoding="utf-8")
        (root / "desktop/src/local-model-store.cjs").write_text(store, encoding="utf-8")
        (root / "desktop/src/local-runtime.cjs").write_text(runtime, encoding="utf-8")
        return temporary, root

    def test_current_style_boundaries_pass(self):
        temporary, root = self.make_repo()
        self.addCleanup(temporary.cleanup)
        self.assertEqual(check_repository(root), [])

    def test_backend_framework_import_is_rejected(self):
        temporary, root = self.make_repo(
            spaced="from fastapi import HTTPException\n"
        )
        self.addCleanup(temporary.cleanup)
        violations = check_repository(root)
        self.assertTrue(
            any("spaced_repetition.py" in item and "fastapi" in item for item in violations)
        )

    def test_review_service_infrastructure_import_is_rejected(self):
        temporary, root = self.make_repo(
            review="import psycopg\n"
        )
        self.addCleanup(temporary.cleanup)
        violations = check_repository(root)
        self.assertTrue(
            any(
                "review_service.py" in item
                and "psycopg" in item
                for item in violations
            )
        )

    def test_local_ai_electron_import_is_rejected(self):
        temporary, root = self.make_repo(
            runtime="const { app } = require('electron')\n"
        )
        self.addCleanup(temporary.cleanup)
        violations = check_repository(root)
        self.assertTrue(
            any("local-runtime.cjs" in item and "electron" in item for item in violations)
        )


if __name__ == "__main__":
    unittest.main()
