"""Regression checks for the integrated staging database bootstrap."""
from pathlib import Path
import unittest

from application_schema import staging_application_schema


REQUIRED_TABLES = (
    "quiz_history",
    "user_identities",
    "decks",
    "cards",
    "card_review_logs",
    "study_notification_preferences",
    "study_push_subscriptions",
    "study_notification_deliveries",
)


class ApplicationSchemaTests(unittest.TestCase):
    def test_uses_full_canonical_rls_schema_and_staging_database(self):
        canonical_path = Path(__file__).resolve().parents[1] / "production" / "schema.sql"
        canonical = canonical_path.read_text()
        adapted = staging_application_schema(canonical)

        self.assertEqual(adapted.count("DATABASE quizforge_rehearsal "), 4)
        self.assertNotIn("DATABASE quizforge ", adapted)
        for table in REQUIRED_TABLES:
            self.assertIn(f"CREATE TABLE app.{table} (", adapted)
            self.assertIn(f"ALTER TABLE app.{table} ENABLE ROW LEVEL SECURITY;", adapted)
        self.assertIn("CREATE FUNCTION app.move_card(", adapted)
        self.assertIn("GRANT EXECUTE", adapted)


if __name__ == "__main__":
    unittest.main()
