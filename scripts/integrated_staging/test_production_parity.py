"""Critical behavioural parity is automatic; declared differences are bounded."""
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import zipfile

from production_parity import compare_sources, report, PROD, STAGE, PROD_OPS, DIFFERENCES
from package_recovery import package, SOURCE, ENTRY


class ProductionParityAudit(unittest.TestCase):
    def test_checked_in_config_matches_production_except_declared_differences(self):
        r = report()
        self.assertEqual(r["critical_mismatches"], [])
        self.assertEqual(r["result"], "PASS")
        self.assertEqual(set(r["intentional_differences"]), set(DIFFERENCES))

    def test_detects_password_mfa_token_and_lambda_drift(self):
        prod = PROD.read_text()
        stage = STAGE.read_text()
        ops = PROD_OPS.read_text()
        mutations = [
            stage.replace('mfa_configuration        = "OPTIONAL"', 'mfa_configuration        = "ON"', 1),
            stage.replace('minimum_length                   = 8', 'minimum_length                   = 14', 1),
            stage.replace('refresh_token_validity               = 1', 'refresh_token_validity               = 72', 1),
            stage.replace('lambda_config { post_confirmation = aws_lambda_function.recovery.arn }', '', 1),
            stage.replace('Resource = aws_cognito_user_pool.browser.arn', 'Resource = "*"', 1),
        ]
        for changed in mutations:
            self.assertNotEqual(changed, stage)
            with self.subTest(change=changed[:130]):
                self.assertNotEqual(compare_sources(prod, changed, ops), [])

    def test_exact_production_recovery_source_and_deterministic_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / "recovery.zip"
            package(p)
            first = p.read_bytes()
            package(p)
            self.assertEqual(p.read_bytes(), first)
            with zipfile.ZipFile(p) as archive:
                self.assertEqual(archive.namelist(), [ENTRY])
                self.assertEqual(archive.read(ENTRY), SOURCE.read_bytes())


if __name__ == "__main__":
    unittest.main()
