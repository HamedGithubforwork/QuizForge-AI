import contextlib
import copy
import io
import unittest
from unittest.mock import patch

import identity_triggers


class IdentityTriggerTests(unittest.TestCase):
    def event(self, trigger="PostConfirmation_ConfirmForgotPassword"):
        return {"triggerSource": trigger, "region": "ca-central-1", "userPoolId": "ca-central-1_Disposable",
                "userName": "fixture-subject", "request": {"userAttributes": {"email": "private@example.test"},
                "clientMetadata": {"userName": "another-user", "userPoolId": "another-pool"}}, "response": {}}

    def test_reset_revokes_only_cognito_event_subject_and_preserves_mfa_attributes(self):
        event = self.event()
        original = copy.deepcopy(event)
        output = io.StringIO()
        with patch.object(identity_triggers.boto3, "client") as client, contextlib.redirect_stdout(output):
            result = identity_triggers.handler(event, None)
            client.return_value.admin_user_global_sign_out.assert_called_once_with(
                UserPoolId="ca-central-1_Disposable", Username="fixture-subject")
        self.assertEqual(result, original)
        self.assertEqual(output.getvalue(), "")

    def test_revocation_failure_never_returns_success_or_provider_secrets(self):
        with patch.object(identity_triggers.boto3, "client") as client:
            client.return_value.admin_user_global_sign_out.side_effect = RuntimeError("private@example.test secret-token")
            with self.assertRaisesRegex(RuntimeError, "^Recovery session revocation failed$"):
                identity_triggers.handler(self.event(), None)

    def test_signup_confirmation_does_not_change_account_or_call_revocation(self):
        event = self.event("PostConfirmation_ConfirmSignUp")
        with patch.object(identity_triggers.boto3, "client") as client:
            self.assertEqual(identity_triggers.handler(event, None), event)
            client.assert_not_called()

    def test_public_signup_still_uses_fail_closed_guard(self):
        with patch.object(identity_triggers.boto3, "client") as client:
            with self.assertRaises(ValueError): identity_triggers.handler(self.event("PreSignUp_SignUp"), None)
            client.assert_not_called()

    def test_unexpected_trigger_or_region_never_revokes_any_user(self):
        for event in (self.event("PostAuthentication_Authentication"), {**self.event(), "region": "us-east-1"}):
            with patch.object(identity_triggers.boto3, "client") as client:
                with self.assertRaises(ValueError): identity_triggers.handler(event, None)
                client.assert_not_called()
