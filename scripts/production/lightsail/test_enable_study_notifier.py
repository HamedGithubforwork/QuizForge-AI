import hashlib
import unittest

from scripts.production.lightsail import (
    enable_study_notifier,
)


class StudyNotifierActivationTests(
    unittest.TestCase
):
    def test_reviewed_units_are_exact_and_nonempty(self):
        for path in (
            enable_study_notifier.SERVICE,
            enable_study_notifier.TIMER,
        ):
            self.assertTrue(
                path.is_file()
            )
            self.assertGreater(
                path.stat().st_size,
                20,
            )
            self.assertRegex(
                enable_study_notifier.sha256(
                    path
                ),
                r"^[a-f0-9]{64}$",
            )

    def test_activation_requires_private_credentials_and_probe(self):
        remote = (
            enable_study_notifier
            .REMOTE
        )

        for value in (
            "/etc/quizforge/notifier.env",
            "/etc/quizforge/web-push-private.env",
            "/etc/quizforge/web-push-public.env",
            "quizforge_notifier",
            "--profile scheduled",
            "run --rm --no-deps notifier",
            "notifier_probe_succeeded",
            "systemctl enable --now quizforge-study-notifier.timer",
        ):
            self.assertIn(
                value,
                remote,
            )

        self.assertIn(
            "OPENAI_API_KEY",
            remote,
        )
        self.assertIn(
            "not in notifier",
            remote,
        )

    def test_units_keep_recurrence_bounded(self):
        service = (
            enable_study_notifier
            .SERVICE
            .read_text()
        )
        timer = (
            enable_study_notifier
            .TIMER
            .read_text()
        )

        self.assertIn(
            "Type=oneshot",
            service,
        )
        self.assertIn(
            "--profile scheduled run --rm --no-deps notifier",
            service,
        )
        self.assertIn(
            "OnUnitInactiveSec=15min",
            timer,
        )
        self.assertIn(
            "RandomizedDelaySec=30s",
            timer,
        )
        self.assertNotIn(
            "OnCalendar=*:*:00",
            timer,
        )


if __name__ == "__main__":
    unittest.main()
