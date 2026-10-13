"""Synthetic guard tests: never connect to AWS or print OAuth secrets."""
import copy
import unittest
from scripts.production.lightsail.google_plan_guard import authorize, IDENTITY_PROVIDER, BROWSER_CLIENT

ID = "123456789-synthetic.apps.googleusercontent.com"
SECRET = "synthetic-test-only-secret"

def plan():
    existing = {
        "client_id": "syntheticbrowser", "name": "quizforge-production-pkce",
        "user_pool_id": "ca-central-1_SyntheticPool",
        "callback_urls": ["https://quizfromnotes.com/auth/callback"],
        "logout_urls": ["https://quizfromnotes.com/"],
        "allowed_oauth_flows": ["code"],
        "allowed_oauth_scopes": ["openid", "email", "aws.cognito.signin.user.admin"],
        "explicit_auth_flows": ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_PASSWORD_AUTH"],
        "refresh_token_validity": 1, "id_token_validity": 5, "access_token_validity": 5,
        "supported_identity_providers": ["COGNITO"]
    }
    updated = {**existing, "supported_identity_providers": ["COGNITO", "Google"]}
    return {
        "format_version": "1.2", "resource_drift": [],
        "resource_changes": [
            {"address": IDENTITY_PROVIDER, "change": {"actions": ["create"], "before": None,
                "after": {"provider_name": "Google", "provider_type": "Google",
                          "provider_details": {"client_id": ID, "client_secret": SECRET, "authorize_scopes": "openid email"},
                          "attribute_mapping": {"email": "email", "email_verified": "email_verified"}}}},
            {"address": BROWSER_CLIENT, "change": {"actions": ["update"],
                "before": existing, "after": updated}},
            {"address": "aws_cognito_user_pool.browser", "change": {"actions": ["no-op"],
                "before": {}, "after": {}}},
        ]
    }

class TestGoogleOnlyPlan(unittest.TestCase):
    def test_exact_changes_only(self):
        report = authorize(plan(), ID)
        self.assertTrue(report["approved"])
        self.assertFalse(report["production_changes_applied"])
        self.assertNotIn(SECRET, str(report))

    def test_refuses_other_changes_and_destruction(self):
        for extra in [
            {"address": "aws_lightsail_instance.server", "change": {"actions": ["update"], "before": {}, "after": {}}},
            {"address": "aws_cognito_user_pool.browser", "change": {"actions": ["delete"], "before": {}, "after": {}}},
            {"address": IDENTITY_PROVIDER, "change": {"actions": ["delete", "create"], "before": {}, "after": {}}},
        ]:
            p = plan()
            p["resource_changes"].append(extra)
            with self.subTest(extra=extra["address"]), self.assertRaises(ValueError):
                authorize(p, ID)

    def test_refuses_missing_or_altered_providers(self):
        p = plan()
        p["resource_changes"].pop(0)
        with self.assertRaises(ValueError):
            authorize(p, ID)
        p = plan()
        p["resource_changes"][1]["change"]["after"]["supported_identity_providers"] = ["Google"]
        with self.assertRaises(ValueError):
            authorize(p, ID)
        p = plan()
        p["resource_changes"][0]["change"]["after"]["provider_details"]["client_id"] = "different.apps.googleusercontent.com"
        with self.assertRaises(ValueError):
            authorize(p, ID)

    def test_refuses_account_changes_and_drift(self):
        p = plan()
        p["resource_changes"][1]["change"]["after"]["callback_urls"] = ["https://evil.example"]
        with self.assertRaises(ValueError):
            authorize(p, ID)
        p = plan()
        p["resource_drift"] = [{"address": "aws_cognito_user_pool.browser"}]
        with self.assertRaises(ValueError):
            authorize(p, ID)
        p = plan()
        p["resource_changes"][0]["change"]["after"]["provider_details"]["client_secret"] = ""
        with self.assertRaises(ValueError):
            authorize(p, ID)

if __name__ == "__main__":
    unittest.main()
