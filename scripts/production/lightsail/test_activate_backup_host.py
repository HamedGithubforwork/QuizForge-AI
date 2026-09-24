from __future__ import annotations

import unittest

from scripts.production.lightsail.activate_backup_host import (
    HEALTH_USER,
    RECOVERY_USER,
    REMOTE_INSTALL_AND_RUN,
    UPLOADER_USER,
)


class FirstProductionBackupTests(unittest.TestCase):
    def test_three_backup_identities_are_separate(self):
        self.assertEqual(
            len({UPLOADER_USER, HEALTH_USER, RECOVERY_USER}),
            3,
        )

    def test_host_install_keeps_recurring_timers_disabled(self):
        self.assertIn(
            "systemctl disable --now quizforge-backup.timer quizforge-backup-health.timer",
            REMOTE_INSTALL_AND_RUN,
        )
        self.assertIn(
            "! systemctl is-enabled --quiet quizforge-backup.timer",
            REMOTE_INSTALL_AND_RUN,
        )
        self.assertIn(
            "! systemctl is-enabled --quiet quizforge-backup-health.timer",
            REMOTE_INSTALL_AND_RUN,
        )

    def test_first_run_uses_existing_private_database_and_reviewed_units(self):
        self.assertIn(
            "PGHOST",
            REMOTE_INSTALL_AND_RUN,
        )
        self.assertIn(
            "db.quizforge.internal",
            REMOTE_INSTALL_AND_RUN,
        )
        self.assertIn(
            '"PGHOSTADDR":"127.0.0.1"',
            REMOTE_INSTALL_AND_RUN,
        )
        self.assertIn(
            "python3-venv",
            REMOTE_INSTALL_AND_RUN,
        )
        self.assertIn(
            "python -m pip check",
            REMOTE_INSTALL_AND_RUN,
        )
        self.assertIn(
            "systemctl start quizforge-backup.service",
            REMOTE_INSTALL_AND_RUN,
        )
        self.assertIn(
            "/etc/quizforge/backup.key",
            REMOTE_INSTALL_AND_RUN,
        )

    def test_activation_does_not_touch_application_or_ai(self):
        lowered = REMOTE_INSTALL_AND_RUN.lower()
        self.assertNotIn("route53", lowered)
        self.assertIn("test -f /etc/quizforge/launch-approved", lowered)
        self.assertNotIn("touch /etc/quizforge/launch-approved", lowered)
        self.assertNotIn("rm -f /etc/quizforge/launch-approved", lowered)
        self.assertNotIn("tee /etc/quizforge/launch-approved", lowered)
        self.assertNotIn("openai_api_key", lowered)
        self.assertNotIn("generation_policy", lowered)
        self.assertNotIn("quizforge.service start", lowered)


if __name__ == "__main__":
    unittest.main()
