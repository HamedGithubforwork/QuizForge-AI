"""Regression tests for privacy-safe AWS recovery update failure diagnosis."""
import contextlib
import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import fast_recovery


class SafeDiagnosticTests(unittest.TestCase):
    def test_rejection_labels_cannot_embed_arbitrary_provider_details(self):
        for text in fast_recovery.SAFE_REJECTION_REASONS:
            self.assertIsInstance(text, str)
            self.assertFalse(any(char in text for char in ("\\n", "\\r", ":", "=")))
            self.assertLess(len(text), 120)
        self.assertNotIn("private-token", fast_recovery.SAFE_REJECTION_REASONS)

    def test_failed_targeted_plan_reports_exact_stage_without_raw_aws_data(self):
        bad_plan = {
            "format_version": "1.2",
            "resource_drift": [],
            "resource_changes": [
                {"mode": "managed", "address": "aws_lambda_function.production",
                 "change": {"actions": ["create"], "before": None, "after": {
                     "client_secret": "super-sensitive-provider-data"}}}
            ],
        }
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch.dict(os.environ, {
                    "RUNNER_TEMP": tmp,
                    "STAGING_AUTH_UPDATE": "align_recovery_hook",
                }),
                patch.object(fast_recovery, "package"),
                patch.object(fast_recovery.fast_frontend, "live",
                             return_value=({"pool": "ca-central-1_Fixture"}, {})),
                patch.object(fast_recovery.fast_password, "live_minimum", return_value=8),
                patch.object(fast_recovery.fast_parity, "live_email_controls"),
                patch.object(fast_recovery, "live_attached", return_value=None),
                patch.object(fast_recovery.control, "signup_policy", return_value=False),
                patch.object(fast_recovery.fast_auth, "_terraform",
                             side_effect=["", json.dumps(bad_plan)]) as tf,
                contextlib.redirect_stdout(output),
            ):
                with self.assertRaises(ValueError):
                    fast_recovery.update()
                self.assertEqual(tf.call_count, 2)  # saved plan never applied
        logged = output.getvalue()
        self.assertIn("STAGING_RECOVERY_PHASE=audit-targeted-terraform-plan", logged)
        self.assertIn("STAGING_RECOVERY_GUARD=Recovery migration contains unrelated resource changes", logged)
        self.assertNotIn("super-sensitive-provider-data", logged)
        self.assertNotIn("aws_lambda_function.production", logged)


if __name__ == "__main__":
    unittest.main()
