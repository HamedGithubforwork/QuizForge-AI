from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from scripts.production.lightsail.release_candidate import (
    LEGACY_URL,
    discover_public_config,
    read_public_source,
    safe_public_summary,
)


class FakeSTS:
    def get_caller_identity(self):
        return {"Account": "123456789012"}


class FakeCognito:
    def list_user_pools(self, **kwargs):
        return {
            "UserPools": [
                {
                    "Name": "quizforge-production-lightsail",
                    "Id": "ca-central-1_SyntheticPool",
                }
            ]
        }

    def list_user_pool_clients(self, **kwargs):
        self.pool = kwargs["UserPoolId"]
        return {
            "UserPoolClients": [
                {
                    "ClientName": "quizforge-production-pkce",
                    "ClientId": "syntheticclient123",
                }
            ]
        }

    def describe_user_pool_domain(self, **kwargs):
        self.domain = kwargs["Domain"]
        return {
            "DomainDescription": {
                "UserPoolId": "ca-central-1_SyntheticPool",
            }
        }

    def describe_user_pool_client(self, **kwargs):
        return {"UserPoolClient": {
            "ClientId": kwargs["ClientId"],
            "SupportedIdentityProviders": ["COGNITO"],
            "CallbackURLs": ["https://quizfromnotes.com/auth/callback"],
            "LogoutURLs": ["https://quizfromnotes.com/"],
            "AllowedOAuthFlows": ["code"],
            "GenerateSecret": False,
        }}

    def describe_identity_provider(self, **kwargs):
        raise AssertionError("Google provider must not be read when disabled")

    def get_user_pool_mfa_config(self, **kwargs):
        self.mfa_pool = kwargs["UserPoolId"]
        return {
            "MfaConfiguration": "ON",
            "SoftwareTokenMfaConfiguration": {"Enabled": True},
        }


class ReleaseCandidateTests(unittest.TestCase):
    def source(self):
        return {
            "legacy_url": LEGACY_URL,
            "legacy_publishable_key":
                "sb_publishable_synthetic_public_key_123456789",
        }

    def test_public_source_accepts_only_publishable_client_key(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "public.json"
            path.write_text(json.dumps(self.source()))
            value = read_public_source(path)
            self.assertEqual(value["legacy_url"], LEGACY_URL)

            for bad in (
                self.source() | {"legacy_publishable_key": "sb_secret_private"},
                self.source() | {"legacy_url": "https://foreign.example"},
                self.source() | {"extra": "x"},
            ):
                path.write_text(json.dumps(bad))
                with self.assertRaises(ValueError):
                    read_public_source(path)

    def test_discovery_binds_exact_pool_client_and_domain(self):
        cognito = FakeCognito()
        config = discover_public_config(self.source(), FakeSTS(), cognito)
        self.assertEqual(config["pool"], "ca-central-1_SyntheticPool")
        self.assertEqual(config["client"], "syntheticclient123")
        self.assertEqual(
            config["auth_origin"],
            "https://quizforge-123456789012.auth.ca-central-1.amazoncognito.com",
        )
        self.assertEqual(cognito.domain, "quizforge-123456789012")
        self.assertEqual(cognito.mfa_pool, "ca-central-1_SyntheticPool")
        self.assertFalse(config["sms_mfa_enabled"])
        self.assertFalse(config["google_signin_enabled"])

        summary = safe_public_summary(config)
        self.assertFalse(summary["sms_mfa_enabled"])
        self.assertFalse(summary["google_signin_enabled"])
        self.assertTrue(all(
            summary[key]
            for key in summary
            if key not in {"schema", "sms_mfa_enabled", "google_signin_enabled"}
        ))
        raw = json.dumps(summary)
        self.assertNotIn(config["legacy_publishable_key"], raw)
        self.assertNotIn(config["pool"], raw)
        self.assertNotIn(config["client"], raw)

    def test_sms_mfa_discovery_is_public_and_explicit(self):
        class Sms(FakeCognito):
            def get_user_pool_mfa_config(self, **kwargs):
                return {
                    "MfaConfiguration": "ON",
                    "SoftwareTokenMfaConfiguration": {"Enabled": True},
                    "SmsMfaConfiguration": {
                        "SmsAuthenticationMessage": "Code {####}",
                    },
                }

        config = discover_public_config(self.source(), FakeSTS(), Sms())
        self.assertTrue(config["sms_mfa_enabled"])
        self.assertTrue(safe_public_summary(config)["sms_mfa_enabled"])

    def test_production_google_enabled_only_for_verified_browser_client_and_idp(self):
        class Google(FakeCognito):
            def describe_user_pool_client(self, **kwargs):
                data = super().describe_user_pool_client(**kwargs)
                data["UserPoolClient"]["SupportedIdentityProviders"] = ["COGNITO", "Google"]
                return data

            def describe_identity_provider(self, **kwargs):
                return {"IdentityProvider": {
                    "ProviderType": "Google",
                    "ProviderDetails": {
                        "client_id": "synthetic.apps.googleusercontent.com",
                        "authorize_scopes": "openid email",
                    },
                }}

        expected = discover_public_config(self.source(), FakeSTS(), Google())
        self.assertTrue(expected["google_signin_enabled"])
        self.assertTrue(safe_public_summary(expected)["google_signin_enabled"])

        class BadRedirect(Google):
            def describe_user_pool_client(self, **kwargs):
                data = super().describe_user_pool_client(**kwargs)
                data["UserPoolClient"]["CallbackURLs"] = ["https://foreign.test/auth/callback"]
                return data

        class UnreviewedGoogle(Google):
            def describe_identity_provider(self, **kwargs):
                data = super().describe_identity_provider(**kwargs)
                data["IdentityProvider"]["ProviderDetails"]["client_id"] = "foreign-id"
                return data

        for invalid in (BadRedirect, UnreviewedGoogle):
            with self.subTest(case=invalid.__name__), self.assertRaises(ValueError):
                discover_public_config(self.source(), FakeSTS(), invalid())

    def test_wrong_domain_attachment_is_refused(self):
        class Bad(FakeCognito):
            def describe_user_pool_domain(self, **kwargs):
                return {"DomainDescription": {"UserPoolId": "wrong"}}

        with self.assertRaises(ValueError):
            discover_public_config(self.source(), FakeSTS(), Bad())


if __name__ == "__main__":
    unittest.main()
