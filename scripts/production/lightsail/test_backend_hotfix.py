from __future__ import annotations

import unittest

from scripts.production.lightsail.backend_hotfix import IMAGE_RE, REMOTE_APPLY


class BackendHotfixTests(unittest.TestCase):
    def test_remote_hotfix_is_api_only_with_guard_rebind_and_rollback(self):
        self.assertIn('value["services"]["api"]["image"]', REMOTE_APPLY)
        self.assertIn('services["identity"].get("image") != old_image', REMOTE_APPLY)
        self.assertIn('--force-recreate --no-deps api', REMOTE_APPLY)
        self.assertIn('--force-recreate --no-deps guard', REMOTE_APPLY)
        self.assertIn('cp "$backup" "$compose"', REMOTE_APPLY)
        self.assertIn('cached_reselection_quota_probe_passed', REMOTE_APPLY)
        self.assertIn('SELECT count(*) FROM admissions', REMOTE_APPLY)
        self.assertIn('assert after == before', REMOTE_APPLY)
        self.assertIn('https://api.quizfromnotes.com/api/health', REMOTE_APPLY)
        self.assertNotIn('route53', REMOTE_APPLY.lower())
        self.assertNotIn('systemctl enable', REMOTE_APPLY)
        self.assertNotIn('systemctl disable', REMOTE_APPLY)
        self.assertNotIn('docker compose -f "$compose" up -d --force-recreate identity', REMOTE_APPLY)

    def test_image_contract_requires_canada_central_ecr_digest(self):
        good = (
            "123456789012.dkr.ecr.ca-central-1.amazonaws.com/"
            "quizforge-api@sha256:" + "a" * 64
        )
        self.assertIsNotNone(IMAGE_RE.fullmatch(good))
        self.assertIsNone(IMAGE_RE.fullmatch("quizforge-api:latest"))
        self.assertIsNone(
            IMAGE_RE.fullmatch(
                "123456789012.dkr.ecr.us-east-1.amazonaws.com/"
                "quizforge-api@sha256:" + "a" * 64
            )
        )


if __name__ == "__main__":
    unittest.main()
