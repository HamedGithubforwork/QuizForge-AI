from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts.production.lightsail import cognito_hash_import_preflight as preflight


class CognitoHashImportPreflightTests(unittest.TestCase):
    def test_csv_requires_hash_column_and_populates_only_expected_fields(self):
        header = ["cognito:username", "email", "email_verified", "updated_at", "cognito:mfa_enabled", "password_hash"]
        payload = preflight.csv_bytes(header, "$2b$12$" + "A" * 53).decode()
        lines = payload.strip("\n").split("\n")
        self.assertEqual(lines[0].split(","), header)
        values = dict(zip(header, lines[1].split(",")))
        self.assertEqual(values["cognito:username"], preflight.TEMP_EMAIL)
        self.assertEqual(values["email"], preflight.TEMP_EMAIL)
        self.assertEqual(values["email_verified"], "TRUE")
        self.assertEqual(values["cognito:mfa_enabled"], "")
        self.assertTrue(values["password_hash"].startswith("$2b$12$"))

    def test_csv_refuses_pool_without_password_hash_capability(self):
        with self.assertRaises(RuntimeError):
            preflight.csv_bytes(["cognito:username", "email", "email_verified"], "$2b$12$" + "A" * 53)

    def test_production_checks_require_mfa_email_and_public_client(self):
        client = mock.Mock()
        client.describe_user_pool.return_value = {"UserPool": {
            "UserPoolTier": "LITE",
            "UsernameAttributes": ["email"],
            "AutoVerifiedAttributes": ["email"],
            "MfaConfiguration": "ON",
        }}
        client.get_user_pool_mfa_config.return_value = {"SoftwareTokenMfaConfiguration": {"Enabled": True}}
        client.describe_user_pool_client.return_value = {"UserPoolClient": {
            "PreventUserExistenceErrors": "ENABLED",
        }}
        checks = preflight.production_checks(client, "ca-central-1_Test", "client")
        self.assertTrue(all(checks.values()))

    def test_classifies_start_preconditions_without_exposing_message(self):
        error = preflight.ClientError(
            {"Error": {"Code": "PreconditionNotMetException", "Message": "The configured CloudWatch Logs role is missing permissions"}},
            "StartUserImportJob",
        )
        self.assertEqual(preflight.classify_client_error(error), "IMPORT_LOG_ROLE")

        active = preflight.ClientError(
            {"Error": {"Code": "PreconditionNotMetException", "Message": "Another import job is active"}},
            "StartUserImportJob",
        )
        self.assertEqual(preflight.classify_client_error(active), "IMPORT_JOB_ACTIVE")

    def test_report_rejects_hashes_and_pool_ids(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(preflight, "RESULT", Path(tmp) / "summary.json"):
            with mock.patch.dict(os.environ, {"RUNNER_TEMP": tmp}):
                with self.assertRaises(RuntimeError):
                    preflight.write_report({"result": "failed", "value": "$2b$12$" + "A" * 53})
                with self.assertRaises(RuntimeError):
                    preflight.write_report({"result": "failed", "value": "ca-central-1_Secret"})


if __name__ == "__main__":
    unittest.main()
