"""Synthetic guard tests: never connect to AWS or print OAuth secrets."""
import copy
import unittest
from scripts.production.lightsail.google_plan_guard import authorize, IDENTITY_PROVIDER, BROWSER_CLIENT, classify_plan_failure, safe_plan_error_hints, safe_plan_log_metrics

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

class TestSafePlanDiagnostics(unittest.TestCase):
    def test_only_known_nonsecret_categories_are_exposed(self):
        raw = "Error: AccessDenied: very-private-access-token-value"
        self.assertEqual(classify_plan_failure(raw, 1), "AWS_READ_PERMISSION_DENIED")
        self.assertEqual(classify_plan_failure("Error: Missing required argument\nsecret=123", 1),
                         "TERRAFORM_MISSING_ARGUMENT")
        self.assertEqual(classify_plan_failure("Error: Invalid function argument", 1),
                         "TERRAFORM_FUNCTION_INVALID")
        self.assertEqual(classify_plan_failure("secretOnlyXYZ", 1), "OTHER_TERRAFORM_PLAN_FAILURE")
        self.assertEqual(classify_plan_failure("secretOnlyXYZ", 0), "NO_CHANGES")
        self.assertEqual(classify_plan_failure("secretOnlyXYZ", 77), "UNEXPECTED_PLAN_EXIT")

class TestAllowlistedDiagnosticTitles(unittest.TestCase):
    def test_only_allowlisted_tokens_escape_error_titles(self):
        title = "Error: Invalid AWS provider configuration - stolen-personalSecretBearerToken-ABCD12345"
        safe = safe_plan_error_hints(title)
        self.assertTrue(safe)
        self.assertNotIn("stolen", str(safe))
        self.assertNotIn("bearer", str(safe).lower())
        self.assertNotIn("12345", str(safe))
        self.assertIn("invalid", safe[0])
        self.assertEqual(safe_plan_error_hints("Nothing here"), ["unrecognized_terraform_error"])

class TestTerraformBoxedDiagnostics(unittest.TestCase):
    def test_box_characters_do_not_hide_errors(self):
        raw = "╷\n│ Error: Invalid function argument\n│\n╵\n"
        self.assertEqual(safe_plan_error_hints(raw), ["invalid_function_argument"])
        secret = "not_allowed_secret_value_ABCXYZ999"
        raw = "│ Error: Invalid variable " + secret
        safe = safe_plan_error_hints(raw)
        self.assertNotIn(secret, str(safe))
        self.assertIn("invalid", safe[0])

class TestPrivateLogMetrics(unittest.TestCase):
    def test_fixed_key_log_metrics_do_not_echo_secret(self):
        private = "shhh-randomOAuthKey-ABC123456"
        m = safe_plan_log_metrics("Terraform ERROR: " + private)
        self.assertGreater(m["bytes"], 10)
        self.assertTrue(m["terraform_error_prefix"])
        self.assertNotIn(private, str(m))
        self.assertEqual(m["permitted_error_word_counts"].get("error"), 1)

class TestSafelyRedactedErrorContext(unittest.TestCase):
    def test_no_sensitive_values_can_escape_near_errors(self):
        private = "DoNotPrintOAuthSecretXYZ987"
        m = safe_plan_log_metrics("line\nError: Invalid provider details " + private +
                                  "\nsecret " + private + " cannot be read")
        self.assertEqual(m["error_context"][0]["line"], 2)
        self.assertIn("invalid", m["error_context"][0]["safe_terms"])
        self.assertNotIn(private, str(m))
