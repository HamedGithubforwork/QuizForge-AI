from __future__ import annotations
import unittest
from scripts.production.lightsail.enable_backup_timers import REMOTE

class BackupTimerActivationTests(unittest.TestCase):
    def test_requires_successful_recovery_point_before_scheduling(self):
        self.assertIn('value["last_attempt"]["outcome"]=="succeeded"', REMOTE)
        self.assertIn('payload["format"]=="quizforge-backup-receipt-v1"', REMOTE)
        self.assertIn('systemctl show quizforge-backup.service -p Result --value', REMOTE)

    def test_enables_only_reviewed_backup_timers_and_health_check(self):
        self.assertIn("systemctl enable --now quizforge-backup.timer quizforge-backup-health.timer", REMOTE)
        self.assertIn("systemctl start quizforge-backup-health.service", REMOTE)
        self.assertIn("NextElapseUSecRealtime", REMOTE)
        self.assertIn("systemctl disable --now quizforge-backup.timer quizforge-backup-health.timer", REMOTE)
        self.assertNotIn("quizforge.service start", REMOTE)
        self.assertNotIn("route53", REMOTE.lower())
        self.assertNotIn("openai", REMOTE.lower())

if __name__=="__main__":
    unittest.main()
