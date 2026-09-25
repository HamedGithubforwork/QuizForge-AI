from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from uuid import UUID

from scripts.production import cognito_identity_import
from scripts.production.lightsail import migrate_supabase_auth_to_cognito as migration


class CognitoCredentialMigrationTests(unittest.TestCase):
    def test_build_csv_preserves_hash_and_disables_mfa_import(self):
        users = [{
            "id": str(UUID(int=1)),
            "email": "one@example.com",
            "password_hash": "$2b$12$" + "A" * 53,
            "email_verified": True,
            "history_count": 9,
        }]
        header = ["cognito:username", "email", "email_verified", "cognito:mfa_enabled", "password_hash"]
        raw = migration.build_csv(header, users).decode().strip().splitlines()
        self.assertEqual(raw[0].split(","), header)
        row = raw[1].split(",")
        values = dict(zip(header, row))
        self.assertEqual(values["cognito:username"], "one@example.com")
        self.assertEqual(values["email_verified"], "TRUE")
        self.assertEqual(values["cognito:mfa_enabled"], "")
        self.assertEqual(values["password_hash"], users[0]["password_hash"])

    def test_user_set_digest_ignores_password_hash(self):
        first = [{"id": str(UUID(int=1)), "email": "one@example.com", "history_count": 2, "password_hash": "a"}]
        second = [{**first[0], "password_hash": "b"}]
        self.assertEqual(migration.user_set_digest(first), migration.user_set_digest(second))

    def test_identity_mapping_loader_rejects_duplicates(self):
        value = {
            "schema": 1,
            "cognito_issuer": "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Test",
            "users": [
                {"legacy_user_id": str(UUID(int=1)), "cognito_subject": str(UUID(int=2))},
                {"legacy_user_id": str(UUID(int=1)), "cognito_subject": str(UUID(int=3))},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mapping.json"
            path.write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                cognito_identity_import.load_mapping(path)

    def test_state_must_match_exact_source_set(self):
        ssm = mock.Mock()
        ssm.get_parameter.return_value = {"Parameter": {"Value": json.dumps({
            "schema": 1,
            "user_set_sha256": "a" * 64,
            "count": migration.EXPECTED_USERS,
            "import_succeeded": True,
            "mapping_succeeded": False,
        })}}
        with self.assertRaises(ValueError):
            migration.read_state(ssm, "b" * 64)

    def test_report_refuses_private_values(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(migration, "RESULT", Path(tmp) / "summary.json"):
            with self.assertRaises(ValueError):
                migration.write_report({"result": "failed", "value": "private@example.com"}, ["private@example.com"])


if __name__ == "__main__":
    unittest.main()
