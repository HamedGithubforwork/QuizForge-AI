from __future__ import annotations
import unittest
from scripts.production.lightsail.diagnose_backup_host import REMOTE_DIAG

class BackupHostDiagnosticTests(unittest.TestCase):
    def test_diagnostic_is_read_only(self):
        self.assertIn("systemctl","systemctl")
        self.assertIn("journalctl",REMOTE_DIAG)
        self.assertIn("status.json",REMOTE_DIAG)
        self.assertNotIn("systemctl start",REMOTE_DIAG)
        self.assertNotIn("systemctl enable",REMOTE_DIAG)
        self.assertNotIn("systemctl disable",REMOTE_DIAG)
        self.assertNotIn("rm -f /etc/quizforge/backup",REMOTE_DIAG)
        self.assertNotIn("tee /etc/quizforge/backup",REMOTE_DIAG)
        self.assertNotIn("route53",REMOTE_DIAG.lower())
        self.assertNotIn("aws_access_key_id",REMOTE_DIAG.lower())

if __name__=="__main__":
    unittest.main()
