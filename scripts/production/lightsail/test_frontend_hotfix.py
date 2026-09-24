from __future__ import annotations
import unittest

from scripts.production.lightsail.frontend_hotfix import REMOTE_APPLY


class FrontendHotfixTests(unittest.TestCase):
    def test_remote_hotfix_is_frontend_only_with_atomic_rollback(self):
        self.assertIn("/opt/quizforge/frontend", REMOTE_APPLY)
        self.assertIn(".frontend-rollback-", REMOTE_APPLY)
        self.assertIn("mv /opt/quizforge/frontend", REMOTE_APPLY)
        self.assertIn("mv "$backup" /opt/quizforge/frontend", REMOTE_APPLY)
        self.assertIn("--force-recreate --no-deps web", REMOTE_APPLY)
        self.assertIn("Sign in or create account", REMOTE_APPLY)
        self.assertIn("quizfromnotes.com:443:127.0.0.1", REMOTE_APPLY)
        self.assertNotIn("route53", REMOTE_APPLY.lower())
        self.assertNotIn("generation_policy", REMOTE_APPLY)
        self.assertNotIn("OPENAI_API_KEY", REMOTE_APPLY)
        self.assertNotIn("systemctl enable", REMOTE_APPLY)
        self.assertNotIn("systemctl disable", REMOTE_APPLY)


if __name__ == "__main__":
    unittest.main()
