"""No real OIDC request or AWS session is created by these tests."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.backup_activation.access import Sessions, github_oidc_token, resource_policy, state_policy
from scripts.backup_activation.contract import Refused
from scripts.backup_activation.tests.fixtures import SETTINGS, environment


class AccessBoundaryTests(unittest.TestCase):
    def test_untrusted_oidc_endpoint_never_receives_bearer(self):
        for endpoint in ("http://example.invalid/token", "https://actions.githubusercontent.com.evil.invalid/token",
                         "https://example.invalid/token", "https://user@pipelines.actions.githubusercontent.com/token",
                         "https://pipelines.actions.githubusercontent.com:444/token",
                         "https://pipelines.actions.githubusercontent.com/token?audience=untrusted"):
            env = {"ACTIONS_ID_TOKEN_REQUEST_URL": endpoint, "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "synthetic-bearer"}
            with self.subTest(endpoint=endpoint), patch("urllib.request.build_opener") as opener:
                with self.assertRaises(Refused):
                    github_oidc_token(env)
                opener.assert_not_called()

    def test_separate_profiles_drop_previous_write_credentials(self):
        # Bypass SDK construction, not the actual profile-rotation method.
        session = Sessions.__new__(Sessions)
        session.settings = SETTINGS
        session.credentials = {"qf-state": {"old": "write-session"}, "qf-resources": {"old": "write-session"}}
        requested = []
        def obtain(profile, policy):
            self.assertNotIn("qf-state", session.credentials)
            requested.append((profile, json.loads(policy)))
            session.credentials[profile] = {"synthetic": "read-session"}
        with patch.object(session, "obtain", side_effect=obtain), patch.object(session, "write_profiles") as write:
            session.prepare(write=False, include_state=False)
            write.assert_called_once()
        self.assertEqual(list(session.credentials), ["qf-resources"])
        actions = requested[0][1]["Statement"][0]["Action"]
        self.assertNotIn("iam:CreatePolicy", actions)
        self.assertNotIn("sns:Subscribe", actions)

    def test_terraform_environment_excludes_ambient_overrides_and_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            session = Sessions.__new__(Sessions)
            session.directory = Path(directory)
            session.settings = SETTINGS
            session.env = dict(environment(), PATH="/synthetic/bin", AWS_ACCESS_KEY_ID="untrusted",
                               AWS_SECRET_ACCESS_KEY="untrusted", AWS_SESSION_TOKEN="untrusted",
                               AWS_ENDPOINT_URL="https://example.invalid", TF_CLI_ARGS="-lock=false",
                               TF_LOG="TRACE", GITHUB_TOKEN="synthetic-github-token", HTTPS_PROXY="untrusted")
            actual = session.terraform_env()
            for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_ENDPOINT_URL",
                        "TF_CLI_ARGS", "TF_LOG", "GITHUB_TOKEN", "HTTPS_PROXY"):
                self.assertNotIn(key, actual)
            self.assertEqual(actual["AWS_PROFILE"], "qf-resources")
            self.assertEqual(actual["TF_WORKSPACE"], "default")
            self.assertEqual(actual["TF_VAR_alert_email"], SETTINGS.email)
            self.assertEqual(actual["AWS_SHARED_CREDENTIALS_FILE"], str(Path(directory) / "credentials"))

    def test_all_synthetic_policies_fit_without_action_or_account_wildcards(self):
        for write in (False, True):
            for text in (resource_policy(SETTINGS, write), state_policy(SETTINGS, write)):
                self.assertLessEqual(len(text), 2048)
                self.assertNotIn("arn:aws:iam::*", text)
                self.assertNotIn("arn:aws:sns:ca-central-1:*", text)
                self.assertNotIn('"iam:*"', text)
                self.assertNotIn('"s3:*"', text)


if __name__ == "__main__":
    unittest.main()
