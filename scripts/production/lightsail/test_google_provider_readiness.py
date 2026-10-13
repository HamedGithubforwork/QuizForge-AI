"""No-cloud tests for the protected production Google OAuth preflight."""
import unittest
from types import SimpleNamespace

from scripts.production.lightsail.google_provider_readiness import (
    inspect_account, validate_google_credentials,
)

GOOGLE_ID = "123456789-abcdef012345.apps.googleusercontent.com"
SECRET = "synthetic-sensitive-oauth-secret"


class MissingProvider(Exception):
    response = {"Error": {"Code": "ResourceNotFoundException"}}


class FakeSts:
    def __init__(self, account="399311815467"):
        self.account = account

    def get_caller_identity(self):
        return {"Account": self.account}


class FakeCognito:
    def __init__(self, provider=False, allowed=False, mismatch=False):
        self.provider = provider
        self.allowed = allowed
        self.mismatch = mismatch
        self.mutations = []

    def list_user_pools(self, **kwargs):
        return {"UserPools": [{"Name": "quizforge-production-lightsail", "Id": "ca-central-1_TestPool"}]}

    def list_user_pool_clients(self, **kwargs):
        return {"UserPoolClients": [{"ClientName": "quizforge-production-pkce", "ClientId": "browser123"}]}

    def describe_user_pool_client(self, **kwargs):
        return {"UserPoolClient": {
            "SupportedIdentityProviders": ["COGNITO", "Google"] if self.allowed else ["COGNITO"],
            "CallbackURLs": ["https://quizfromnotes.com/auth/callback"],
            "LogoutURLs": ["https://quizfromnotes.com/"],
            "AllowedOAuthFlows": ["code"],
            "GenerateSecret": False,
        }}

    def describe_identity_provider(self, **kwargs):
        if not self.provider:
            raise MissingProvider("AWS private details")
        return {"IdentityProvider": {
            "ProviderType": "Google",
            "ProviderDetails": {
                "client_id": "different.apps.googleusercontent.com" if self.mismatch else GOOGLE_ID,
                "client_secret": SECRET,
                "authorize_scopes": "openid email",
            },
        }}


class TestProductionGooglePreflight(unittest.TestCase):
    def run_preflight(self, **kwargs):
        return inspect_account(sts=kwargs.pop("sts", FakeSts()),
                               cognito=kwargs.pop("cognito", FakeCognito()),
                               client_id=kwargs.pop("client_id", GOOGLE_ID),
                               secret=kwargs.pop("secret", SECRET))

    def test_credentials_are_format_checked_without_logging(self):
        self.assertTrue(validate_google_credentials(GOOGLE_ID, SECRET))
        for bad_id, bad_secret in (
            ("", SECRET), ("not-a-google-client", SECRET),
            (GOOGLE_ID, None), (GOOGLE_ID, "short"),
            (GOOGLE_ID, "contains whitespace"),
        ):
            with self.subTest(client=bad_id, secret_ok=bad_secret is not None):
                self.assertFalse(validate_google_credentials(bad_id, bad_secret))

    def test_missing_provider_is_read_only_and_safe(self):
        cognito = FakeCognito()
        self.assertEqual(self.run_preflight(cognito=cognito), "not_connected_ready_for_review")
        self.assertEqual(cognito.mutations, [])

    def test_existing_provider_and_client_states(self):
        self.assertEqual(self.run_preflight(cognito=FakeCognito(provider=True)),
                         "google_provider_exists_not_authorized_for_client")
        self.assertEqual(self.run_preflight(cognito=FakeCognito(provider=True, allowed=True)),
                         "google_provider_and_client_configured")

    def test_fails_closed_for_unexpected_provider_or_account(self):
        for opts in (
            {"cognito": FakeCognito(mismatch=True, provider=True)},
            {"cognito": FakeCognito(allowed=True)},
            {"sts": FakeSts("000000000000")},
            {"secret": "invalid"},
        ):
            with self.subTest(case=tuple(opts)), self.assertRaises(ValueError):
                self.run_preflight(**opts)

    def test_rejects_invalid_callback(self):
        class BadCallback(FakeCognito):
            def describe_user_pool_client(self, **kwargs):
                result = super().describe_user_pool_client(**kwargs)
                result["UserPoolClient"]["CallbackURLs"] = ["https://attacker.example/callback"]
                return result
        with self.assertRaises(ValueError):
            self.run_preflight(cognito=BadCallback())


if __name__ == "__main__":
    unittest.main()
