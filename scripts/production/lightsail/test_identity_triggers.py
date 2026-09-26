import contextlib
import copy
import io
import unittest
from unittest.mock import patch

from scripts.production.lightsail import identity_triggers


class IdentityTriggerTests(unittest.TestCase):
    def event(self, trigger="PostConfirmation_ConfirmForgotPassword"):
        return {
            "triggerSource": trigger,
            "region": "ca-central-1",
            "userPoolId": "ca-central-1_Disposable",
            "userName": "fixture-subject",
            "request": {
                "userAttributes": {"email": "private@example.test"},
                "clientMetadata": {
                    "userName": "another-user",
                    "userPoolId": "another-pool",
                },
            },
            "response": {},
        }

    def test_reset_revokes_only_cognito_event_subject(self):
        event = self.event()
        original = copy.deepcopy(event)
        output = io.StringIO()
        with (
            patch.object(identity_triggers.boto3, "client") as client,
            contextlib.redirect_stdout(output),
        ):
            result = identity_triggers.handler(event, None)
            client.return_value.admin_user_global_sign_out.assert_called_once_with(
                UserPoolId="ca-central-1_Disposable",
                Username="fixture-subject",
            )
        self.assertEqual(result, original)
        self.assertEqual(output.getvalue(), "")

    def test_revocation_failure_never_returns_provider_details(self):
        with patch.object(identity_triggers.boto3, "client") as client:
            client.return_value.admin_user_global_sign_out.side_effect = RuntimeError(
                "private@example.test secret-token"
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "^Recovery session revocation failed$",
            ):
                identity_triggers.handler(self.event(), None)

    def test_signup_confirmation_does_not_revoke(self):
        event = self.event("PostConfirmation_ConfirmSignUp")
        with patch.object(identity_triggers.boto3, "client") as client:
            self.assertEqual(identity_triggers.handler(event, None), event)
            client.assert_not_called()

    def test_unexpected_trigger_or_region_never_revokes(self):
        for event in (
            self.event("PreSignUp_SignUp"),
            self.event("PostAuthentication_Authentication"),
            {**self.event(), "region": "us-east-1"},
        ):
            with (
                self.subTest(event=event),
                patch.object(identity_triggers.boto3, "client") as client,
            ):
                with self.assertRaises(ValueError):
                    identity_triggers.handler(event, None)
                client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
