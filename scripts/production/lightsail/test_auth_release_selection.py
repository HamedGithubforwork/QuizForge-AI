"""Build-only release selection safety checks; no cloud services."""
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).parents[3]


class TestAuthReleaseSelection(unittest.TestCase):
    def test_candidate_and_google_enabled_release_are_immutable(self):
        selected = json.loads((ROOT / "scripts/production/lightsail/auth-release-selection.json").read_text())
        live = json.loads((ROOT / "scripts/production/lightsail/release-lock.json").read_text())
        self.assertEqual(set(selected), {
            "schema", "application_candidate_sha", "reviewed_source_tree_sha",
            "rollout_stage", "reviewed_pr",
        })
        self.assertEqual(selected["schema"], 1)
        self.assertEqual(selected["reviewed_pr"], 619)
        self.assertEqual(selected["rollout_stage"], "google-enabled-release")
        self.assertEqual(selected["application_candidate_sha"],
                         "730027a5027e7479e67ad5ddb660b32b74eab322")
        self.assertEqual(selected["reviewed_source_tree_sha"],
                         "0fc2e41634629af2dce84ba4dbb45d9a15190169")
        self.assertEqual(live["application_candidate_sha"],
                         "730027a5027e7479e67ad5ddb660b32b74eab322")
        self.assertEqual(live["release_sha"], "84460039f45557c48cec0baf79e9e961ab96af23")
        self.assertTrue(live["public_configuration_validated"])
        self.assertFalse(live["ai_enabled"])
        self.assertRegex(selected["application_candidate_sha"], r"^[0-9a-f]{40}$")

    def test_builder_must_not_deploy_or_auto_promote(self):
        workflow = (ROOT / ".github/workflows/lightsail-release-candidate-build.yml").read_text()
        self.assertIn("google-enabled-release", workflow)
        self.assertIn("Verify exact reviewed source tree", workflow)
        self.assertNotIn("terraform apply", workflow)
        self.assertNotIn("promote_release", workflow)
        self.assertIn("cognito-idp:DescribeUserPoolClient", workflow)
        self.assertIn("cognito-idp:DescribeIdentityProvider", workflow)
        self.assertIn("google_signin_enabled", workflow)
        self.assertIn('"google_signin_enabled": true', workflow)
        self.assertIn('public.get("google_signin_enabled") is True', workflow)

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
