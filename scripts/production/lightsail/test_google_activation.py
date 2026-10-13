from datetime import datetime, timezone, timedelta
from pathlib import Path
import unittest
from scripts.production.lightsail.google_activation import verify_preflight, authorize_rollback, APPLICATION, WORKFLOW
from scripts.production.lightsail.google_plan_guard import IDENTITY_PROVIDER, BROWSER_CLIENT


class GoogleActivationTests(unittest.TestCase):
    def fixture(self):
        now = datetime(2026, 10, 13, tzinfo=timezone.utc)
        metadata = {"updated_at": now.isoformat(), "event": "workflow_dispatch", "path": WORKFLOW,
                    "head_branch": "main", "status": "completed", "conclusion": "success",
                    "repository": {"full_name": "HamedGithubforwork/QuizForge-AI"}}
        lock = {"application_candidate_sha": APPLICATION, "release_sha": "a" * 40, "ai_enabled": False}
        report = {"inspection_only": True, "preflight_verified": True, "observed_current_release_sha": "a" * 40,
                  "release_sha": "a" * 40, "release_switched": False, "frontend_switched": False,
                  "baseline_firewall_restored": True, "temporary_ssh_rule_closed": True,
                  "result": "production_promotion_preflight_verified"}
        return metadata, report, lock, now

    def test_fresh_exact_backend_required(self):
        self.assertTrue(verify_preflight(*self.fixture())["backend_release_verified"])
        for index, key, value in [(0, "event", "pull_request"), (0, "head_branch", "unreviewed"),
                                  (0, "path", "other.yml"), (0, "conclusion", "failure"),
                                  (1, "observed_current_release_sha", "b" * 40),
                                  (1, "preflight_verified", False), (1, "inspection_only", False),
                                  (1, "baseline_firewall_restored", False),
                                  (2, "application_candidate_sha", "b" * 40), (2, "ai_enabled", True)]:
            fixture = list(self.fixture())
            fixture[index][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                verify_preflight(*fixture)
        metadata, report, lock, now = self.fixture()
        with self.assertRaises(ValueError):
            verify_preflight(metadata, report, lock, now + timedelta(minutes=16))

    def rollback(self):
        client = {"user_pool_id": "ca-central-1_Synthetic", "callback_urls": ["https://quizfromnotes.com/auth/callback"],
                  "supported_identity_providers": ["COGNITO", "Google"]}
        return {"format_version": "1.2", "resource_changes": [
            {"address": IDENTITY_PROVIDER, "change": {"actions": ["delete"], "before": {
                "user_pool_id": "ca-central-1_Synthetic", "provider_name": "Google", "provider_type": "Google"}, "after": None}},
            {"address": BROWSER_CLIENT, "change": {"actions": ["update"], "before": client,
                "after": {**client, "supported_identity_providers": ["COGNITO"]}}},
        ]}

    def test_rollback_complete_partial_and_no_change(self):
        p = self.rollback()
        self.assertTrue(authorize_rollback(p, "ca-central-1_Synthetic")["rollback_scope_verified"])
        p["resource_changes"].pop()
        self.assertTrue(authorize_rollback(p, "ca-central-1_Synthetic")["rollback_scope_verified"])
        p["resource_changes"].clear()
        self.assertTrue(authorize_rollback(p, "ca-central-1_Synthetic")["rollback_scope_verified"])

    def test_rollback_rejects_unrelated_destructive_and_browser_changes(self):
        cases = []
        p = self.rollback(); p["resource_changes"].append({"address": "aws_lightsail_instance.server", "change": {"actions": ["delete"]}}); cases.append(p)
        p = self.rollback(); p["resource_changes"][0]["change"]["before"]["provider_name"] = "Other"; cases.append(p)
        p = self.rollback(); p["resource_changes"][0]["change"]["before"]["user_pool_id"] = "ca-central-1_Other"; cases.append(p)
        p = self.rollback(); p["resource_changes"][1]["change"]["after"]["callback_urls"] = ["https://evil.example"]; cases.append(p)
        p = self.rollback(); p["resource_drift"] = [{"address": "other"}]; cases.append(p)
        for p in cases:
            with self.assertRaises(ValueError):
                authorize_rollback(p, "ca-central-1_Synthetic")

    def test_workflow_requires_live_backend_and_exact_scope_before_apply(self):
        workflow = (Path(__file__).parents[3] / ".github/workflows/production-google-activation.yml").read_text()
        self.assertIn("backend_preflight_run_id", workflow)
        self.assertIn("quizforge-permanent-existing-release-promotion", workflow)
        self.assertLess(workflow.index("google_activation preflight"), workflow.index("apply -input=false"))
        self.assertLess(workflow.index('google_plan_guard "$RUNNER_TEMP/terraform-plan.json"'),
                        workflow.index("apply -input=false"))
        self.assertIn("steps.scope.outputs.pool_arn", workflow)
        self.assertIn("terraform.tfstate.tflock", workflow)
        self.assertIn("google_activation rollback", workflow)
        for forbidden in ("lambda:UpdateFunction", "lightsail:Create", "cognito-idp:UpdateUserPool\"",
                          "cognito-idp:DeleteUserPool\"", "s3:DeleteBucket"):
            self.assertNotIn(forbidden, workflow)

    def test_frontend_repair_cannot_publish_on_release_lock_push(self):
        workflow = (Path(__file__).parents[3] / ".github/workflows/lightsail-frontend-hotfix.yml").read_text()
        self.assertNotIn("  push:", workflow)
        self.assertIn("github.event_name == 'workflow_dispatch'", workflow)
        self.assertIn("quizforge-permanent-existing-release-promotion", workflow)
        self.assertIn("cognito-idp:DescribeUserPoolClient", workflow)
        self.assertIn("cognito-idp:DescribeIdentityProvider", workflow)


if __name__ == "__main__":
    unittest.main()
