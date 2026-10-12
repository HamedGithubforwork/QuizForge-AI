"""Fail-closed recovery tests for full staging before expensive image builds."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

from guards import NAME
from preflight import classify, run, PreflightBlocked, REQUIRED_OWNED_RESOURCES

ACCOUNT = "123456789012"


def state():
    return sorted(REQUIRED_OWNED_RESOURCES | {"aws_ecs_service.app[\"api\"]"})


def values(delta=timedelta(minutes=-5)):
    return {
        "name": NAME, "bucket": NAME + "-" + ACCOUNT,
        "auth_domain": "quizforge-integrated-" + ACCOUNT,
        "api_url": "https://staging-api.quizfromnotes.com",
        "pool": "ca-central-1_Testpool", "domain": "d123.cloudfront.net",
        "deadline": (datetime.now(timezone.utc) + delta).isoformat(),
    }


class ExpiredRecovery(unittest.TestCase):
    def test_empty_state_passes_only_without_outputs(self):
        self.assertEqual(classify([], None, None), "empty")
        with self.assertRaises(PreflightBlocked):
            classify([], values(), ACCOUNT)

    def test_expired_verified_state_is_eligible_for_recovery(self):
        self.assertEqual(classify(state(), values(), ACCOUNT), "expired")
        self.assertEqual(classify(state(), values(timedelta(hours=-8)), ACCOUNT), "expired")

    def test_active_leases_protected_even_if_close_to_expiration(self):
        for minutes in (0.2, 10, 60, 120):
            with self.subTest(minutes=minutes), self.assertRaisesRegex(PreflightBlocked, "active staging lease"):
                classify(state(), values(timedelta(minutes=minutes)), ACCOUNT)

    def test_invalid_or_overlong_leases_fail_closed(self):
        for deadline in ("missing", "not-a-date", "", "2035-01-01T00:00:00Z"):
            with self.subTest(deadline=deadline), self.assertRaises(PreflightBlocked):
                classify(state(), {**values(), "deadline": deadline}, ACCOUNT)
        with self.assertRaises(PreflightBlocked):
            classify(state(), {**values(), "deadline": datetime.now().isoformat()}, ACCOUNT)

    def test_partial_foreign_production_and_missing_ownership_fail_closed(self):
        mutations = [
            (["aws_s3_bucket.site"], values(), ACCOUNT),
            (state() + ["aws_db_instance.production"], values(), ACCOUNT),
            (state() + ["module.production.aws_s3_bucket.site"], values(), ACCOUNT),
            (state(), None, ACCOUNT),
            (state(), {**values(), "name": "quizforge-production"}, ACCOUNT),
            (state(), {**values(), "bucket": "quizforge-production"}, ACCOUNT),
            (state(), {**values(), "domain": "prod.quizfromnotes.com"}, ACCOUNT),
            (state(), {**values(), "pool": "us-east-1_pool"}, ACCOUNT),
            (state(), {**values(), "auth_domain": "quizforge-integrated-000000000000"}, ACCOUNT),
            (state(), {**values(), "api_url": "https://api.quizfromnotes.com"}, ACCOUNT),
            (state(), values(), "000000000000"),
        ]
        for resources, output, account in mutations:
            with self.subTest(resources=resources, account=account), self.assertRaises((AssertionError, PreflightBlocked)):
                classify(resources, output, account)

    def test_expired_run_recovers_and_verifies_absence_once(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
            "STAGING_PREFLIGHT_ACTION": "run",
            "STAGING_SELF_SIGNUP": "true",
            "GITHUB_REF": "refs/heads/main",
            "TF_VAR_hostname": "staging-api.quizfromnotes.com",
            "GITHUB_STEP_SUMMARY": str(Path(temp) / "summary.md"),
        }), patch("preflight.control.state_resources", return_value=state()), (
            patch("preflight.control.values", return_value=values())
        ), patch("preflight.control.client") as client, patch("preflight.control.stop_tasks") as stop, (
            patch("preflight._destroy")
        ) as destroy, patch("preflight.control.absent") as absent:
            client.return_value.get_caller_identity.return_value = {"Account": ACCOUNT}
            run()
            stop.assert_called_once_with()
            destroy.assert_called_once_with()
            absent.assert_called_once_with()
            self.assertIn("ENABLED", (Path(temp) / "summary.md").read_text())

    def test_active_run_never_stops_or_deletes(self):
        with patch.dict(os.environ, {
            "STAGING_PREFLIGHT_ACTION": "run",
            "STAGING_SELF_SIGNUP": "false",
            "GITHUB_REF": "refs/heads/main",
            "TF_VAR_hostname": "staging-api.quizfromnotes.com",
        }), patch("preflight.control.state_resources", return_value=state()), (
            patch("preflight.control.values", return_value=values(timedelta(hours=1)))
        ), patch("preflight.control.client") as client, patch("preflight.control.stop_tasks") as stop, (
            patch("preflight._destroy")
        ) as destroy, patch("preflight.control.absent") as absent:
            client.return_value.get_caller_identity.return_value = {"Account": ACCOUNT}
            with self.assertRaisesRegex(PreflightBlocked, "active staging lease"):
                run()
            stop.assert_not_called()
            destroy.assert_not_called()
            absent.assert_not_called()

    def test_absent_run_verifies_orphans_before_allowing_build(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
            "STAGING_PREFLIGHT_ACTION": "run",
            "STAGING_SELF_SIGNUP": "false",
            "GITHUB_REF": "refs/heads/main",
            "TF_VAR_hostname": "staging-api.quizfromnotes.com",
            "GITHUB_STEP_SUMMARY": str(Path(temp) / "summary.md"),
        }), patch("preflight.control.state_resources", return_value=[]), (
            patch("preflight.control.client")
        ) as client, patch("preflight.control.stop_tasks") as stop, (
            patch("preflight._destroy")
        ) as destroy, patch("preflight.control.absent") as absent:
            run()
            client.assert_not_called()
            stop.assert_not_called()
            destroy.assert_not_called()
            absent.assert_called_once_with()
            self.assertIn("DISABLED", (Path(temp) / "summary.md").read_text())

    def test_does_not_run_outside_trusted_explicit_main(self):
        for env in ({"GITHUB_REF": "refs/heads/dev", "STAGING_PREFLIGHT_ACTION": "run"},
                    {"GITHUB_REF": "refs/heads/main", "STAGING_PREFLIGHT_ACTION": "stop"},
                    {"GITHUB_REF": "refs/heads/main", "STAGING_PREFLIGHT_ACTION": ""}):
            with self.subTest(env=env), patch.dict(os.environ, env), (
                patch("preflight.control.state_resources")
            ) as get_state, self.assertRaises(PreflightBlocked):
                run()
                get_state.assert_not_called()


if __name__ == "__main__":
    unittest.main()
