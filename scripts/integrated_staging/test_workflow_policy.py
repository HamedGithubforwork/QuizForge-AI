"""Keep pull-request validation separate from manual staging operations."""
import re
from pathlib import Path
import unittest


WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "aws-integrated-staging.yml"
OIDC_IDENTITY_WORKFLOW = WORKFLOW.with_name("aws-oidc-identity-check.yml")
QUICK_UPDATE_WORKFLOW = WORKFLOW.with_name("aws-integrated-staging-frontend-update.yml")


def block(text, key, indent=2):
    prefix = " " * indent
    match = re.search(
        rf"(?ms)^{re.escape(prefix)}{re.escape(key)}:\s*\n(.*?)(?=^{re.escape(prefix)}[A-Za-z0-9_-]+:\s*$|\Z)",
        text,
    )
    if not match:
        raise AssertionError(f"Missing YAML block {key!r}")
    return match.group(1)


class StagingWorkflowPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")
        cls.jobs = block(cls.workflow, "jobs", indent=0)

    def test_pull_request_runs_credentialless_validation_only(self):
        validate = block(self.jobs, "validate", indent=2)
        select_prs = block(self.jobs, "select-prs", indent=2)
        preflight = block(self.jobs, "preflight", indent=2)
        images = block(self.jobs, "images", indent=2)

        self.assertIn("github.event_name == 'pull_request'", validate)
        self.assertNotIn("id-token: write", validate)
        self.assertNotIn("configure-aws-credentials", validate)
        self.assertIn("github.event_name == 'workflow_dispatch'", select_prs)
        self.assertIn("inputs.operation == 'run'", select_prs)
        self.assertNotIn("id-token: write", select_prs)
        self.assertNotIn("configure-aws-credentials", select_prs)
        self.assertIn("checks: read", select_prs)
        self.assertIn("pull-requests: read", select_prs)
        self.assertNotIn("github.event_name == 'pull_request'", preflight)
        self.assertNotIn("github.event_name == 'pull_request'", images)
        self.assertIn("needs.select-prs.result == 'success'", preflight)
        self.assertIn("needs.preflight.result == 'success'", images)

    def test_manual_run_requires_explicit_pr_inputs_without_stale_defaults(self):
        dispatch = block(self.workflow, "workflow_dispatch", indent=2)
        inputs = block(dispatch, "inputs", indent=4)
        for name in ("backend_pr", "frontend_pr"):
            input_block = block(inputs, name, indent=6)
            self.assertIn("required: false", input_block)
            self.assertNotRegex(input_block, r"(?m)^\s+default:")
        self.assertNotRegex(self.workflow, r"inputs\.(?:backend|frontend)_pr\s*\|\|\s*['\"](?:537|538)['\"]")
        self.assertIn("PREVIEW_BACKEND_PR: ${{ inputs.backend_pr }}", self.workflow)
        self.assertIn("PREVIEW_FRONTEND_PR: ${{ inputs.frontend_pr }}", self.workflow)

    def test_quick_update_manual_frontend_run_has_no_stale_pr_default(self):
        workflow = QUICK_UPDATE_WORKFLOW.read_text(encoding="utf-8")
        dispatch = block(workflow, "workflow_dispatch", indent=2)
        inputs = block(dispatch, "inputs", indent=4)
        frontend_pr = block(inputs, "frontend_pr", indent=6)
        self.assertIn("required: false", frontend_pr)
        self.assertNotRegex(frontend_pr, r"(?m)^\s+default:")
        self.assertIn("inputs.operation == 'frontend'", workflow)
        self.assertIn("PREVIEW_FRONTEND_PR: ${{ github.event_name == 'push' && '538' || inputs.frontend_pr }}", workflow)
        self.assertIn("frontend-signup-resume-checklist-v2.json", workflow)
        authorization = (
            Path(__file__).resolve().parents[2]
            / "scripts" / "integrated_staging" / "auto_frontend_merge.py"
        ).read_text(encoding="utf-8")
        self.assertIn('"mode": "one-time-reviewed-main-merge"', authorization)

    def test_exact_selected_refs_feed_images_and_staging_gates_remain_manual(self):
        select_prs = block(self.jobs, "select-prs", indent=2)
        images = block(self.jobs, "images", indent=2)
        confirm_prs = block(self.jobs, "confirm-prs", indent=2)
        provision = block(self.jobs, "provision", indent=2)

        self.assertIn("outputs.backend_sha", select_prs)
        self.assertIn("outputs.frontend_sha", select_prs)
        self.assertIn("needs.select-prs.outputs.backend_sha", images)
        self.assertIn("needs.select-prs.outputs.frontend_sha", images)
        self.assertIn("inputs.operation == 'run'", provision)
        self.assertIn("needs.preflight.result == 'success'", provision)
        self.assertIn("id-token: write", provision)
        self.assertIn("configure-aws-credentials", provision)
        # Application-PR metadata is fetched in the credentialless selector;
        # the Docker build job receives only the verified immutable SHAs.
        self.assertNotIn("checks: read", images)
        self.assertNotIn("pull-requests: read", images)
        self.assertIn("needs: [validate, select-prs, preflight, images]", confirm_prs)
        self.assertNotIn("id-token: write", confirm_prs)
        self.assertIn("PREVIEW_EXPECT_BACKEND_SHA", confirm_prs)
        self.assertIn("PREVIEW_EXPECT_FRONTEND_SHA", confirm_prs)
        self.assertIn("needs.confirm-prs.result == 'success'", provision)

    def test_stop_cleanup_remains_independent_of_pr_inputs(self):
        cleanup = block(self.jobs, "cleanup", indent=2)
        self.assertIn("inputs.operation == 'stop'", cleanup)
        self.assertNotIn("inputs.backend_pr", cleanup)
        self.assertNotIn("inputs.frontend_pr", cleanup)

    def test_oidc_identity_check_is_manual_main_only_and_sts_scoped(self):
        workflow = OIDC_IDENTITY_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", workflow)
        self.assertNotRegex(workflow, r"(?m)^\s+(?:pull_request|push|schedule):")
        for guard in (
            "github.event_name == 'workflow_dispatch'",
            "github.ref == 'refs/heads/main'",
            "github.actor_id == '148009407'",
            "github.repository_id == '1307099196'",
            "github.repository_owner_id == '148009407'",
            "github.repository_owner_id == '356387243'",
            "environment: production",
            "mask-aws-account-id: true",
            '"Action":"sts:GetCallerIdentity"',
            "expected_account = \"399311815467\"",
            "QuizForgeGitHubTerraform/",
        ):
            self.assertIn(guard, workflow)
        aws_commands = re.findall(r"(?m)^\s*aws\s+([^\r\n]+)", workflow)
        self.assertEqual(len(aws_commands), 1)
        self.assertTrue(aws_commands[0].startswith("sts get-caller-identity --output json | python -c"))
        self.assertNotRegex(workflow, r"(?i)\b(?:terraform|ecr|cognito|lightsail|deploy|apply)\b")
        self.assertIn("aws sts get-caller-identity", workflow)


if __name__ == "__main__":
    unittest.main()
