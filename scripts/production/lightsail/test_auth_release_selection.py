"""Build-only release selection safety checks; no cloud services."""
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).parents[3]


class TestAuthReleaseSelection(unittest.TestCase):
    def test_candidate_is_immutable_and_promoted_lock_untouched(self):
        selected = json.loads((ROOT / "scripts/production/lightsail/auth-release-selection.json").read_text())
        live = json.loads((ROOT / "scripts/production/lightsail/release-lock.json").read_text())
        self.assertEqual(set(selected), {
            "schema", "application_candidate_sha", "reviewed_source_tree_sha",
            "rollout_stage", "reviewed_pr",
        })
        self.assertEqual(selected["schema"], 1)
        self.assertEqual(selected["reviewed_pr"], 579)
        self.assertEqual(selected["rollout_stage"], "build-only-google-disabled")
        self.assertEqual(selected["application_candidate_sha"],
                         "77a060cce504008a4479deacdc31279633d0fe4f")
        self.assertEqual(selected["reviewed_source_tree_sha"],
                         "8016b2fce8056bd642bd615eef71eab106ae3800")
        self.assertEqual(live["application_candidate_sha"],
                         "953c4c41322707ff60d5825caa314f58b4bc5b27")
        self.assertEqual(live["release_sha"], "eadbea3748bddbff3b03382b2cf18d7e480dec78")
        self.assertRegex(selected["application_candidate_sha"], r"^[0-9a-f]{40}$")

    def test_builder_must_not_deploy_or_auto_promote(self):
        workflow = (ROOT / ".github/workflows/lightsail-release-candidate-build.yml").read_text()
        self.assertIn("build-only-google-disabled", workflow)
        self.assertIn("Verify exact reviewed source tree", workflow)
        self.assertNotIn("terraform apply", workflow)
        self.assertNotIn("promote_release", workflow)
        self.assertIn("cognito-idp:DescribeUserPoolClient", workflow)
        self.assertIn("cognito-idp:DescribeIdentityProvider", workflow)
        self.assertIn("google_signin_enabled", workflow)
        self.assertIn('"google_signin_enabled": false', workflow)

    def test_auth_release_preserves_existing_native_client_activation(self):
        selected = json.loads((ROOT / "scripts/production/lightsail/auth-release-selection.json").read_text())
        desktop = json.loads((ROOT / "scripts/production/lightsail/desktop-activation.json").read_text())
        self.assertEqual(desktop, {"schema": 1,
                                 "application_candidate_sha": selected["application_candidate_sha"]})
        workflow = (ROOT / ".github/workflows/lightsail-release-candidate-build.yml").read_text()
        self.assertEqual(workflow.count('      - "scripts/production/lightsail/desktop-activation.json"'), 2)
        self.assertIn("application-candidate/desktop/src/native-runtime.json", workflow)
        self.assertIn("application-candidate/desktop/scripts/native-client-config.cjs", workflow)


if __name__ == "__main__":
    unittest.main()
