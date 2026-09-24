from __future__ import annotations
import unittest
from scripts.production.lightsail.public_launch_diagnose import REMOTE_DIAG

class PublicLaunchDiagnosticTests(unittest.TestCase):
    def test_diagnostic_is_read_only_and_bounded(self):
        self.assertIn("docker compose", REMOTE_DIAG)
        self.assertIn("docker inspect", REMOTE_DIAG)
        self.assertIn("systemctl show", REMOTE_DIAG)
        self.assertNotIn("systemctl start", REMOTE_DIAG)
        self.assertNotIn("systemctl enable", REMOTE_DIAG)
        self.assertNotIn("systemctl stop", REMOTE_DIAG)
        self.assertNotIn("launch-approved", REMOTE_DIAG.replace('"launch_marker_present"', ""))
        self.assertNotIn("route53", REMOTE_DIAG.lower())

if __name__=="__main__":
    unittest.main()
