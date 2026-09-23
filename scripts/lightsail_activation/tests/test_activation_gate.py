from pathlib import Path
import unittest

from scripts.lightsail_activation.gate import (
    APPROVED_MANIFEST_SHA256, CONFIRMATION, Refused, fail, trusted,
)

SHA = "a" * 40


def environment():
    return {
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_REPOSITORY": "HamedGithubforwork/QuizForge-AI",
        "GITHUB_WORKFLOW_REF":
            "HamedGithubforwork/QuizForge-AI/.github/workflows/lightsail-production-activation.yml@refs/heads/main",
        "GITHUB_SHA": SHA,
        "GITHUB_WORKFLOW_SHA": SHA,
        "TF_WORKSPACE": "default",
        "QF_REVIEWED_MANIFEST": APPROVED_MANIFEST_SHA256,
        "QF_CONFIRMATION": CONFIRMATION,
    }


class GateTests(unittest.TestCase):
    def test_exact_activation_authorization_passes(self):
        trusted(environment(), "activate")

    def test_wrong_digest_confirmation_branch_and_debug_are_refused(self):
        cases = [
            ("QF_REVIEWED_MANIFEST", "0" * 64),
            ("QF_CONFIRMATION", "yes"),
            ("GITHUB_REF", "refs/heads/feature"),
            ("ACTIONS_STEP_DEBUG", "true"),
        ]
        for name, value in cases:
            with self.subTest(name=name):
                env = environment()
                env[name] = value
                with self.assertRaises(Refused):
                    trusted(env, "activate")

    def test_verify_needs_manual_main_but_not_activation_phrase(self):
        env = environment()
        env.pop("QF_REVIEWED_MANIFEST")
        env.pop("QF_CONFIRMATION")
        trusted(env, "verify")

    def test_failure_semantics_distinguish_partial_apply(self):
        before = {
            "operation": "activate",
            "apply_attempted": False,
            "terraform_apply_completed": False,
        }
        fail(before, "X")
        self.assertEqual(before["result"], "blocked_no_apply_attempted")

        partial = {
            "operation": "activate",
            "apply_attempted": True,
            "terraform_apply_completed": False,
        }
        fail(partial, "X")
        self.assertEqual(partial["result"], "apply_failed_possible_partial_resources")

        applied = {
            "operation": "activate",
            "apply_attempted": True,
            "terraform_apply_completed": True,
        }
        fail(applied, "X")
        self.assertEqual(applied["result"], "apply_completed_readback_not_verified")


class WorkflowTests(unittest.TestCase):
    def test_activation_workflow_is_manual_main_guarded_and_exact_plan_only(self):
        path = Path(".github/workflows/lightsail-production-activation.yml")
        self.assertTrue(path.is_file())
        workflow = path.read_text()
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertIn(APPROVED_MANIFEST_SHA256, workflow)
        self.assertIn(CONFIRMATION, workflow)
        self.assertIn("inputs.operation", workflow)
        self.assertIn("terraform -chdir=infra/aws/lightsail-production apply", workflow)
        self.assertIn('"$RUNNER_TEMP/lightsail-production.tfplan"', workflow)
        self.assertNotIn("pull_request_target", workflow)
        self.assertNotIn("terraform destroy", workflow)
        self.assertNotIn("terraform import", workflow)
        self.assertNotIn("-target=", workflow)
        self.assertNotIn("force-unlock", workflow)
        self.assertNotIn("state push", workflow)
        self.assertNotIn("route53", workflow.lower())
        self.assertNotIn("public_signup=true", workflow)
        self.assertNotIn("-auto-approve", workflow)

    def test_pr_validation_has_no_cloud_credentials(self):
        workflow = Path(".github/workflows/lightsail-production-activation.yml").read_text()
        validation = workflow.split("  validate:\n", 1)[1].split("  cloud:\n", 1)[0]
        self.assertNotIn("id-token: write", validation)
        self.assertNotIn("secrets.", validation)
        self.assertNotIn("configure-aws-credentials", validation)


if __name__ == "__main__":
    unittest.main()
