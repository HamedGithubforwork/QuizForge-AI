from datetime import datetime, timedelta, timezone
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

import control
import recovery


def deny(code):
    raise ClientError({"Error": {"Code": code, "Message": "private provider detail"}}, "test")


class RecoveryProvider:
    """Small behavioral double: defect switches ensure unsafe outcomes fail."""
    def __init__(self, defect=None):
        self.defect = defect
        self.reset = False

    def initiate_auth(self, **args):
        if self.reset and self.defect != "refresh_survives":
            deny("NotAuthorizedException")
        return {"AuthenticationResult": {"AccessToken": "pre-reset-access"}}

    def get_user(self, AccessToken):
        if AccessToken == "pre-reset-access" and self.reset and self.defect != "access_survives":
            deny("NotAuthorizedException")
        subject = "different-subject" if self.reset and self.defect == "identity_changes" else "subject"
        return {"UserAttributes": [{"Name": "sub", "Value": subject}, {"Name": "email", "Value": "inbox@example.test"},
                                   {"Name": "email_verified", "Value": "true"}],
                "PreferredMfaSetting": "SOFTWARE_TOKEN_MFA",
                "UserMFASettingList": [] if self.defect == "mfa_removed" else ["SOFTWARE_TOKEN_MFA"]}

    def admin_initiate_auth(self, **args):
        if self.reset and args["AuthParameters"]["PASSWORD"] == "old-private-password" and self.defect != "old_password_works":
            deny("NotAuthorizedException")
        if self.reset and self.defect == "mfa_bypass":
            return {"AuthenticationResult": {"AccessToken": "unexpected"}}
        return {"ChallengeName": "SOFTWARE_TOKEN_MFA", "Session": "mfa-session"}

    def confirm_forgot_password(self, ConfirmationCode, Password, **args):
        if self.reset:
            if self.defect == "reusable_code":
                return {}
            deny("ExpiredCodeException")
        if ConfirmationCode != "654321":
            if self.defect == "wrong_code_works":
                return {}
            deny("CodeMismatchException")
        if Password == "weak":
            if self.defect == "weak_password_works":
                return {}
            deny("InvalidPasswordException")
        self.reset = True
        return {"AuthenticationResult": {}} if self.defect == "reset_issues_tokens" else {}

    def admin_respond_to_auth_challenge(self, ChallengeResponses, **args):
        if ChallengeResponses["SOFTWARE_TOKEN_MFA_CODE"] != "123456" and self.defect != "wrong_mfa_works":
            deny("CodeMismatchException")
        return {"AuthenticationResult": {"AccessToken": "post-reset-access"}}


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.state = {"pool": "pool", "client": "browser", "fixture_client": "fixture", "recovery_run": "42",
                      "deadline": (datetime.now(timezone.utc) + timedelta(minutes=20)).isoformat()}
        self.fixture = {**self.state, "email": "inbox@example.test", "subject": "subject", "password": "old-private-password",
                        "totp": "private-mfa-secret", "enrolled_at": 0}
        self.receipt = {"run_id": "42", "code": "654321"}

    def parameters(self):
        return {"Parameters": [{"Name": name, "Type": "SecureString", "Value": value}
                for name, value in zip(recovery.PARAMETERS, (json.dumps(self.fixture), "private-refresh-token"))]}

    def test_valid_binding_decrypts_only_exact_temporary_parameters(self):
        with patch.object(recovery, "ssm") as ssm:
            ssm.return_value.get_parameters.return_value = self.parameters()
            fixture, refresh = recovery.load(self.state, self.receipt)
            self.assertEqual(fixture, self.fixture)
            self.assertEqual(refresh, "private-refresh-token")
            ssm.return_value.get_parameters.assert_called_once_with(Names=recovery.PARAMETERS, WithDecryption=True)

    def test_old_run_expired_window_or_malformed_code_never_decrypts(self):
        cases = [({**self.state, "recovery_run": "41"}, self.receipt),
                 ({**self.state, "deadline": "1970-01-01T00:00:00Z"}, self.receipt),
                 (self.state, {**self.receipt, "code": "bad\nvalue"}), (self.state, {**self.receipt, "extra": "unsafe"})]
        for state, receipt in cases:
            with self.subTest(state=state, receipt=receipt), patch.object(recovery, "ssm") as ssm:
                with self.assertRaises(AssertionError): recovery.load(state, receipt)
                ssm.assert_not_called()

    def test_wrong_pool_plaintext_or_missing_fixture_fails_closed(self):
        for defect in ("pool", "plaintext", "missing"):
            params = self.parameters()
            if defect == "pool": params["Parameters"][0]["Value"] = json.dumps({**self.fixture, "pool": "another-pool"})
            if defect == "plaintext": params["Parameters"][0]["Type"] = "String"
            if defect == "missing": params["Parameters"].pop()
            with self.subTest(defect=defect), patch.object(recovery, "ssm") as ssm:
                ssm.return_value.get_parameters.return_value = params
                with self.assertRaises(AssertionError): recovery.load(self.state, self.receipt)

    def test_stale_fixture_is_not_overwritten(self):
        with patch.object(recovery, "ssm") as ssm:
            ssm.return_value.get_parameters.return_value = self.parameters()
            with self.assertRaises(AssertionError): recovery.save(self.fixture, "refresh")
            ssm.return_value.put_parameter.assert_not_called()

    def test_fixture_uses_standard_encryption_without_overwrite(self):
        with patch.object(recovery, "ssm") as ssm:
            ssm.return_value.get_parameters.return_value = {"Parameters": []}
            recovery.save(self.fixture, "refresh")
            for call in ssm.return_value.put_parameter.call_args_list:
                self.assertEqual(call.kwargs["Type"], "SecureString")
                self.assertEqual(call.kwargs["Tier"], "Standard")
                self.assertFalse(call.kwargs["Overwrite"])
                self.assertIn(call.kwargs["Name"], recovery.PARAMETERS)

    def test_partial_cleanup_deletes_only_exact_names_and_checks_absence(self):
        with patch.object(recovery, "ssm") as ssm, contextlib.redirect_stdout(io.StringIO()):
            ssm.return_value.get_parameters.return_value = {"Parameters": []}
            recovery.cleanup()
            ssm.return_value.delete_parameters.assert_called_once_with(Names=recovery.PARAMETERS)
            ssm.return_value.get_parameters.assert_called_once_with(Names=recovery.PARAMETERS, WithDecryption=False)
            ssm.return_value.get_parameters.return_value = self.parameters()
            with self.assertRaises(AssertionError): recovery.cleanup()

    def test_recovery_start_needs_inbox_and_keeps_public_signup_closed(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(recovery, "empty") as empty, \
                patch.object(control, "values", return_value=None), contextlib.redirect_stdout(io.StringIO()):
            env = {"OPERATION": "recovery-start", "GITHUB_RUN_ID": "42", "GITHUB_ENV": str(Path(tmp) / "env")}
            with patch.dict(os.environ, env, clear=True):
                with self.assertRaises(RuntimeError): control.configure()
                empty.assert_not_called()
            with patch.dict(os.environ, {**env, "COGNITO_REHEARSAL_EMAIL": "inbox@example.test"}, clear=True):
                control.configure()
            written = Path(env["GITHUB_ENV"]).read_text()
            self.assertIn("TF_VAR_email_sha256=\n", written)
            self.assertIn("TF_VAR_recovery_run=42\n", written)
            self.assertNotIn("@", written)

    def probe(self, provider):
        output = io.StringIO()
        with patch.object(control, "totp", return_value="123456"), patch.object(recovery.time, "time", return_value=6001), \
                contextlib.redirect_stdout(output):
            recovery.verify(provider, self.fixture, "private-refresh-token", "654321")
        return output.getvalue()

    def test_full_probe_passes_without_secret_output(self):
        output = self.probe(RecoveryProvider())
        self.assertEqual(output.count("PASS:"), 4)
        for private in ("654321", "123456", "private", "inbox@", "pre-reset-access", "post-reset-access"):
            self.assertNotIn(private, output)

    def test_probe_rejects_each_unsafe_provider_behavior(self):
        for defect in ("wrong_code_works", "weak_password_works", "old_password_works", "access_survives", "refresh_survives",
                       "reset_issues_tokens", "reusable_code", "mfa_bypass", "mfa_removed", "identity_changes", "wrong_mfa_works"):
            with self.subTest(defect=defect), self.assertRaises(AssertionError): self.probe(RecoveryProvider(defect))

    def test_expired_session_cannot_masquerade_as_reset_revocation(self):
        provider = RecoveryProvider()
        provider.get_user = Mock(side_effect=lambda **args: deny("NotAuthorizedException"))
        with self.assertRaises(ClientError): self.probe(provider)
        self.assertFalse(provider.reset)

    def test_unrelated_provider_error_is_not_a_security_pass(self):
        with self.assertRaises(AssertionError):
            recovery.rejected(lambda: deny("TooManyRequestsException"), {"CodeMismatchException"})


if __name__ == "__main__":
    unittest.main()
