import json
from pathlib import Path
import tempfile
import unittest

from scripts.production.lightsail import promote_release


class PromoteReleaseTests(unittest.TestCase):
    def test_remote_switch_requires_backup_migrations_and_rollback(self):
        remote = promote_release.REMOTE_PROMOTE

        for value in (
            "systemctl start quizforge-backup.service",
            "backup_completed=true",
            "app.study_notification_deliveries",
            "quizforge_notifier",
            "web-push-private.env",
            "web-push-public.env",
            'docker compose -f "$stage/compose.json" --profile scheduled config --quiet',
            "rollback()",
            'ln -sfn "$final" /opt/quizforge/current.next',
            'ln -sfn "$new_frontend" /opt/quizforge/frontend.next',
            "https://quizfromnotes.com/",
            "https://api.quizfromnotes.com/api/health",
            "rollback_retained",
        ):
            self.assertIn(value, remote)

        for forbidden in (
            "DROP TABLE",
            "DROP SCHEMA",
            "terraform apply",
            "OPENAI_API_KEY=",
        ):
            self.assertNotIn(
                forbidden,
                remote,
            )

    def test_switch_keeps_previous_release_and_frontend_for_rollback(self):
        remote = promote_release.REMOTE_PROMOTE

        self.assertIn(
            'old_sha="$(basename "$current")"',
            remote,
        )
        self.assertIn(
            'old_frontend="$frontends/$old_sha"',
            remote,
        )
        self.assertNotIn(
            'rm -rf "$current"',
            remote,
        )
        self.assertNotIn(
            'rm -rf "$old_frontend"',
            remote,
        )

    def test_result_parser_accepts_stderr_transport_and_mirrored_marker(self):
        payload = '{"ok":true}'
        self.assertEqual(
            promote_release.combined_qf_results(
                "",
                "sudo-note\nQF_RESULT=" + payload + "\n",
            ),
            [payload],
        )
        line = "QF_RESULT=" + payload + "\n"
        self.assertEqual(
            promote_release.combined_qf_results(
                line,
                line,
            ),
            [payload],
        )

    def test_zero_exit_fallback_keeps_remote_safety_contract(self):
        source = Path(
            "scripts/production/lightsail/promote_release.py"
        ).read_text()
        self.assertIn(
            "result_transport_fallback_used",
            source,
        )
        for value in (
            '"backup_completed_before_switch": True',
            '"release_switched": True',
            '"frontend_switched": True',
            '"local_https_verified": True',
            '"rollback_retained": True',
            "check=True",
            'REMOTE_PROMOTE = r"""set -euo pipefail',
        ):
            self.assertIn(value, source)

    def test_sanitized_report_rejects_ips_and_private_values(self):
        with tempfile.TemporaryDirectory() as directory:
            old = promote_release.RESULT
            try:
                promote_release.RESULT = (
                    Path(directory)
                    / "summary.json"
                )
                promote_release.write_report(
                    {
                        "schema": 1,
                        "result":
                            "production_release_promoted",
                    },
                    ["private-value"],
                )
                value = json.loads(
                    promote_release.RESULT
                    .read_text()
                )
                self.assertEqual(
                    value["schema"],
                    1,
                )

                with self.assertRaises(
                    ValueError
                ):
                    promote_release.write_report(
                        {
                            "result":
                                "private-value",
                        },
                        ["private-value"],
                    )

                with self.assertRaises(
                    ValueError
                ):
                    promote_release.write_report(
                        {
                            "value":
                                "203.0.113.42",
                        },
                        [],
                    )
            finally:
                promote_release.RESULT = old


if __name__ == "__main__":
    unittest.main()
