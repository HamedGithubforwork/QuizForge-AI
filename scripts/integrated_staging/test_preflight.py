"""Manual-stop staging must never be torn down by a new deployment."""
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from guards import NAME, MANUAL_DEADLINE
from preflight import classify, run, PreflightBlocked, REQUIRED_OWNED_RESOURCES

ACCOUNT = "123456789012"


def state():
    return sorted(REQUIRED_OWNED_RESOURCES | {'aws_ecs_service.app["api"]'})


def values(deadline=MANUAL_DEADLINE):
    return {
        "name": NAME, "bucket": NAME + "-" + ACCOUNT,
        "auth_domain": "quizforge-integrated-" + ACCOUNT,
        "api_url": "https://staging-api.quizfromnotes.com",
        "pool": "ca-central-1_Testpool", "domain": "d123.cloudfront.net",
        "deadline": deadline,
    }


class ManualStopPreflight(unittest.TestCase):
    def test_empty_state_only_without_outputs(self):
        self.assertEqual(classify([], None, None), "empty")
        with self.assertRaises(PreflightBlocked):
            classify([], values(), ACCOUNT)

    def test_existing_manual_and_expired_sessions_are_never_auto_deleted(self):
        legacy = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
        for deadline in (MANUAL_DEADLINE, legacy, "not-a-date"):
            with self.subTest(deadline=deadline), self.assertRaisesRegex(PreflightBlocked, "explicitly Stop"):
                classify(state(), values(deadline), ACCOUNT)

    def test_foreign_partial_unknown_resources_fail_closed(self):
        variants = [
            (["aws_s3_bucket.site"], values(), ACCOUNT),
            (state() + ["aws_db_instance.production"], values(), ACCOUNT),
            (state(), {**values(), "name": "production"}, ACCOUNT),
            (state(), {**values(), "bucket": "production"}, ACCOUNT),
            (state(), {**values(), "domain": "prod.quizfromnotes.com"}, ACCOUNT),
            (state(), {**values(), "auth_domain": "quizforge-integrated-000000000000"}, ACCOUNT),
            (state(), {**values(), "pool": "us-east-1_foo"}, ACCOUNT),
            (state(), {**values(), "api_url": "https://api.quizfromnotes.com"}, ACCOUNT),
            (state(), values(), "000000000000"),
            (state(), None, ACCOUNT),
        ]
        for resources, out, account in variants:
            with self.subTest(resources=resources, account=account), self.assertRaises((AssertionError, PreflightBlocked)):
                classify(resources, out, account)

    def test_existing_site_never_triggers_stop_or_terraform_destroy(self):
        with patch.dict(os.environ, {
            "STAGING_PREFLIGHT_ACTION": "run",
            "STAGING_SELF_SIGNUP": "true",
            "GITHUB_REF": "refs/heads/main",
            "TF_VAR_hostname": "staging-api.quizfromnotes.com",
        }), patch("preflight.control.state_resources", return_value=state()), (
            patch("preflight.control.values", return_value=values())
        ), patch("preflight.control.client") as aws, patch("preflight.control.stop_tasks") as stop, (
            patch("preflight.control.absent")
        ) as absent, self.assertRaisesRegex(PreflightBlocked, "explicitly Stop"):
            aws.return_value.get_caller_identity.return_value = {"Account": ACCOUNT}
            run()
        stop.assert_not_called()
        absent.assert_not_called()

    def test_empty_site_requires_independent_absence_and_records_manual_policy(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {
            "STAGING_PREFLIGHT_ACTION": "run",
            "STAGING_SELF_SIGNUP": "true",
            "GITHUB_REF": "refs/heads/main",
            "TF_VAR_hostname": "staging-api.quizfromnotes.com",
            "GITHUB_STEP_SUMMARY": str(Path(tmp) / "summary.md"),
        }), patch("preflight.control.state_resources", return_value=[]), (
            patch("preflight.control.client")
        ) as aws, patch("preflight.control.absent") as absent:
            run()
            aws.assert_not_called()
            absent.assert_called_once_with()
            content = (Path(tmp) / "summary.md").read_text()
            self.assertIn("MANUAL", content)
            self.assertIn("ENABLED", content)

    def test_no_non_main_or_implicit_changes(self):
        for ref, action in (("refs/heads/dev", "run"), ("refs/heads/main", "stop"),
                            ("refs/heads/main", "")):
            with self.subTest(ref=ref, action=action), patch.dict(os.environ, {
                "GITHUB_REF": ref, "STAGING_PREFLIGHT_ACTION": action,
            }), patch("preflight.control.state_resources") as state_check, self.assertRaises(PreflightBlocked):
                run()
            state_check.assert_not_called()


if __name__ == "__main__":
    unittest.main()
