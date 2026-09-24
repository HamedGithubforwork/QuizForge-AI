from __future__ import annotations

import unittest

from scripts.production.lightsail.production_canary_identity import (
    REMOTE_CLEANUP,
    canary_email,
    discover,
    totp,
    validate_fixture,
)


class ProductionCanaryIdentityTests(unittest.TestCase):
    def test_totp_matches_rfc6238_sha1_vector_truncated_to_six_digits(self):
        self.assertEqual(
            totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59),
            "287082",
        )

    def test_canary_email_is_run_scoped_and_non_deliverable(self):
        self.assertEqual(
            canary_email("36000000000"),
            "qf-prod-canary-36000000000@example.invalid",
        )
        with self.assertRaises(ValueError):
            canary_email("bad-run-id")

    def test_discovery_uses_exact_named_pool_and_client_without_optional_describe_fields(self):
        class FakeCognito:
            def list_user_pools(self, **_):
                return {
                    "UserPools": [{
                        "Name": "quizforge-production-lightsail",
                        "Id": "ca-central-1_Abc123",
                    }]
                }

            def list_user_pool_clients(self, **_):
                return {
                    "UserPoolClients": [{
                        "ClientName": "quizforge-production-pkce",
                        "ClientId": "abc123",
                    }]
                }

        self.assertEqual(
            discover(FakeCognito()),
            ("ca-central-1_Abc123", "abc123"),
        )

    def test_fixture_validation_is_exact(self):
        value = {
            "schema": 1,
            "pool": "ca-central-1_Abc123",
            "production_client": "abc123",
            "fixture_client": "def456",
            "username": "synthetic-user",
            "email": "qf-prod-canary-36000000000@example.invalid",
            "password": "Qf9!this-is-a-long-production-canary-password",
            "totp": "GEZDGNBVGY3TQOJQ",
            "subject": "00000000-0000-0000-0000-000000000001",
        }
        self.assertEqual(validate_fixture(value)["email"], value["email"])
        with self.assertRaises(ValueError):
            validate_fixture({**value, "extra": "forbidden"})

    def test_local_cleanup_refuses_history_and_never_deletes_history(self):
        self.assertIn("history_count == 0", REMOTE_CLEANUP)
        self.assertIn("identity_count == 1", REMOTE_CLEANUP)
        self.assertIn("DELETE FROM app.user_identities", REMOTE_CLEANUP)
        self.assertIn("DELETE FROM app.users", REMOTE_CLEANUP)
        self.assertNotIn("DELETE FROM app.quiz_history", REMOTE_CLEANUP)


if __name__ == "__main__":
    unittest.main()
