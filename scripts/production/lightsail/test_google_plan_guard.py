"""Synthetic guard tests: never connect to AWS or print OAuth secrets."""
import copy
import json
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

class TestStructuredTerraformDiagnostics(unittest.TestCase):
    def test_safely_classifies_json_events(self):
        from scripts.production.lightsail.google_plan_guard import safe_json_plan_diagnostics
        private = "HiddenOAuthSecret-do-not-print-123"
        events = "\n".join([
            json.dumps({"@level": "info", "type": "planned_change", "diagnostic": {"severity": "error", "summary": "ignored"}}),
            json.dumps({"@level": "error", "type": "diagnostic", "diagnostic": {
                "severity": "error", "summary": "Unsupported argument " + private,
                "detail": "Google OAuth token: " + private,
            }}),
        ])
        safe = safe_json_plan_diagnostics(events)
        self.assertEqual(len(safe), 1)
        self.assertEqual(safe[0]["category"], "TERRAFORM_UNSUPPORTED_ARGUMENT")
        self.assertIn("unsupported", safe[0]["summary_terms"])
        self.assertTrue(safe[0]["summary_present"])
        self.assertIn("google", safe[0]["detail_terms"])
        self.assertNotIn("HiddenOAuthSecret", str(safe))
        self.assertNotIn(private, str(safe))
        self.assertNotIn("oauth", str(safe).lower())

    def test_non_json_and_non_errors_remain_private(self):
        from scripts.production.lightsail.google_plan_guard import safe_json_plan_diagnostics
        self.assertEqual(safe_json_plan_diagnostics("not-json\n{}\n"), [])


class TestReadOnlyTerraformErrorCategories(unittest.TestCase):
    def test_whitelisted_timeout_and_cycle_classification(self):
        self.assertEqual(classify_plan_failure("Error: Cycle: no resource changes", 1),
                         "TERRAFORM_DEPENDENCY_CYCLE")
        self.assertEqual(classify_plan_failure("request timed out", 1),
                         "AWS_PROVIDER_TIMEOUT")
        self.assertEqual(classify_plan_failure("Error: Plugin did not respond", 1),
                         "TERRAFORM_PROVIDER_PLUGIN_ERROR")

    def test_diagnostic_details_expose_allowlisted_words_only(self):
        from scripts.production.lightsail.google_plan_guard import safe_json_plan_diagnostics
        private = "myprivate-token-ABCDEFG12345"
        data = json.dumps({"type": "diagnostic", "diagnostic": {
            "severity": "error", "summary": "opaque",
            "detail": "request timed out; Google provider " + private,
        }})
        report = safe_json_plan_diagnostics(data)
        self.assertEqual(report[0]["category"], "AWS_PROVIDER_TIMEOUT")
        self.assertIn("timed", report[0]["detail_terms"])
        self.assertNotIn(private, str(report))
        self.assertNotIn("ABCDEFG12345", str(report))

class TestGoogleDisabledProductionBaselineProbe(unittest.TestCase):
    def test_classification_discloses_no_private_values(self):
        from scripts.production.lightsail.google_plan_guard import classify_google_disabled_baseline
        token = "very-private-client-secret-ABC123456"
        self.assertEqual(classify_google_disabled_baseline(0, token), "BASELINE_UNCHANGED")
        self.assertEqual(classify_google_disabled_baseline(2, token),
                         "BASELINE_HAS_UNREVIEWED_CHANGES")
        self.assertEqual(classify_google_disabled_baseline(1, "Error: Missing required argument " + token),
                         "BASELINE_FAILED_TERRAFORM_MISSING_ARGUMENT")
        self.assertEqual(classify_google_disabled_baseline(1, token),
                         "BASELINE_FAILED_OTHER_TERRAFORM_PLAN_FAILURE")
        self.assertNotIn(token, classify_google_disabled_baseline(1, token))
        self.assertEqual(classify_google_disabled_baseline(77, token), "BASELINE_UNEXPECTED_EXIT")

    def test_workflow_comparison_is_read_only_and_explicitly_disables_google(self):
        from pathlib import Path
        workflow = (Path(__file__).parents[3] /
                    ".github/workflows/production-google-terraform-plan.yml").read_text()
        self.assertIn("-var=enable_google_signin=false", workflow)
        self.assertIn('terraform-baseline.log', workflow)
        self.assertIn('classify_google_disabled_baseline', workflow)
        self.assertIn('-refresh=false', workflow)
        self.assertIn('-lock=false', workflow)
        self.assertNotIn("terraform apply", workflow)

class TestProductionScopeDiagnostics(unittest.TestCase):
    def test_only_source_files_from_static_allowlist(self):
        from scripts.production.lightsail.google_plan_guard import safe_json_plan_diagnostics
        private = "private-project-file-name-secret-token"
        for filename, expected in [
            ("auth.tf", "auth.tf"),
            ("main.tf", "main.tf"),
            ("operations.tf", "operations.tf"),
            ("secret/" + private + "/auth.tf", "UNSPECIFIED"),
            (private, "UNSPECIFIED"),
            (None, "UNSPECIFIED"),
        ]:
            event = json.dumps({"type":"diagnostic", "diagnostic":{
                "severity":"error", "summary":"Cannot evaluate", "detail":"",
                "range":{"filename":filename} if filename is not None else None
            }})
            result = safe_json_plan_diagnostics(event)
            self.assertEqual(result[0]["source_file"], expected)
            self.assertNotIn(private, str(result))

    def test_targeted_plans_are_diagnostics_only(self):
        from pathlib import Path
        from scripts.production.lightsail.google_plan_guard import classify_targeted_readonly_probe
        secret = "private-secret-XYZ123456789"
        self.assertEqual(classify_targeted_readonly_probe(0, secret),
                         "TARGETED_SCOPE_NO_CHANGES_NOT_RELEASE_APPROVAL")
        self.assertEqual(classify_targeted_readonly_probe(2, secret),
                         "TARGETED_SCOPE_HAS_CHANGES_NOT_RELEASE_APPROVAL")
        self.assertEqual(classify_targeted_readonly_probe(1, secret),
                         "TARGETED_SCOPE_ERROR_OTHER_TERRAFORM_PLAN_FAILURE")
        self.assertNotIn(secret, classify_targeted_readonly_probe(1, secret))
        workflow = (Path(__file__).parents[3] /
                    ".github/workflows/production-google-terraform-plan.yml").read_text()
        self.assertIn('-target=data.aws_caller_identity.current', workflow)
        self.assertIn('-target=aws_cognito_user_pool_client.browser', workflow)
        self.assertIn('classify_targeted_readonly_probe', workflow)
        self.assertIn('NO DEPLOYMENT APPROVAL', workflow)
        self.assertNotIn('terraform apply', workflow)
