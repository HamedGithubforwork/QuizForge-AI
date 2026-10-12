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
    def test_provider_unknown_field_names_are_immutable_and_values_never_logged(self):
        from test_fast_recovery import plan
        audited = plan()
        audited["resource_changes"][0]["change"]["after_unknown"]["lambda_config"][0] = {
            "post_confirmation": True,
            "pre_authentication": True,
            "userControlledSecretName": "private-auth-token",
        }
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            fast_recovery._safe_hook_shape(audited)
        logged = out.getvalue()
        self.assertIn("STAGING_RECOVERY_COMPUTED_FIELDS=post_confirmation,pre_authentication", logged)
        self.assertIn("STAGING_RECOVERY_UNKNOWN_FIELD_COUNT=1", logged)
        self.assertNotIn("private-auth-token", logged)
        self.assertNotIn("userControlledSecretName", logged)

    def test_rejection_labels_cannot_embed_arbitrary_provider_details(self):
        for text in fast_recovery.SAFE_REJECTION_REASONS:
            self.assertIsInstance(text, str)
            self.assertFalse(any(char in text for char in ("\\n", "\\r", ":", "=")))
            self.assertLess(len(text), 120)
        self.assertNotIn("private-token", fast_recovery.SAFE_REJECTION_REASONS)

    def test_diagnostics_mode_accepts_safe_plan_but_never_applies(self):
        from test_fast_recovery import plan
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch.dict(os.environ, {
                    "RUNNER_TEMP": tmp,
                    "STAGING_AUTH_UPDATE": "align_recovery_hook",
                    "STAGING_RECOVERY_DRY_RUN": "true",
                }),
                patch.object(fast_recovery, "package"),
                patch.object(fast_recovery, "expected_arn",
                             return_value="arn:aws:lambda:ca-central-1:123456789012:function:quizforge-integrated-staging-recovery"),
                patch.object(fast_recovery.fast_frontend, "live",
                             return_value=({"pool": "ca-central-1_TestPool"}, {})),
                patch.object(fast_recovery.fast_password, "live_minimum", return_value=8),
                patch.object(fast_recovery.fast_parity, "live_email_controls"),
                patch.object(fast_recovery, "live_attached", return_value=None),
                patch.object(fast_recovery.control, "signup_policy", return_value=False),
                patch.object(fast_recovery.fast_auth, "_terraform",
                             side_effect=["", json.dumps(plan())]) as terraform,
                contextlib.redirect_stdout(output),
            ):
                fast_recovery.update()
                self.assertEqual(terraform.call_count, 2)
        self.assertIn("STAGING_RECOVERY_PHASE=diagnostic-only-no-aws-mutations", output.getvalue())

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
                patch.object(fast_recovery, "expected_arn",
                             return_value="arn:aws:lambda:ca-central-1:123456789012:function:quizforge-integrated-staging-recovery"),
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
