from __future__ import annotations
import unittest
from scripts.production.lightsail.private_startup_diagnose import REMOTE

class PrivateStartupDiagnosticTests(unittest.TestCase):
    def test_bounded_private_startup_and_cleanup(self):
        self.assertIn("up -d db redis", REMOTE)
        self.assertIn("up -d api identity guard", REMOTE)
        self.assertIn("up -d web", REMOTE)
        self.assertIn("docker compose -f", REMOTE)
        self.assertIn("stop --timeout 30 web guard api identity db redis", REMOTE)
        self.assertIn("disabled-until-explicit-activation-", REMOTE)
        self.assertNotIn("touch /etc/quizforge/launch-approved", REMOTE)
        self.assertNotIn("systemctl enable quizforge", REMOTE)
        self.assertNotIn("systemctl start quizforge", REMOTE)
        self.assertNotIn("route53", REMOTE.lower())

if __name__=="__main__":
    unittest.main()
