import json
from pathlib import Path
import tempfile
import unittest
import subprocess

from scripts.production.lightsail import promote_release


class PromoteReleaseTests(unittest.TestCase):
    def test_failed_remote_gate_reports_location_without_command_or_output(self):
        remote = promote_release.REMOTE_PROMOTE
        # Fail the first host gate before any actual host operation can run.
        script = 'test() { echo "private detail" >&2; return 73; }\n' + remote
        result = subprocess.run(
            ["bash", "-s", "--", "a" * 40, "/unused"],
            input=script, text=True, capture_output=True, timeout=5,
        )
        self.assertEqual(result.returncode, 73)
        line = script.splitlines().index("test -f /etc/quizforge/launch-approved") + 1
        self.assertEqual(
            promote_release.remote_failure_details(result.stdout, result.stderr),
            {"remote_failure_status": 73, "remote_failure_line": line},
        )
        self.assertNotIn("private detail", json.dumps(
            promote_release.remote_failure_details(result.stdout, result.stderr),
        ))

    def test_failure_diagnostics_reject_unbounded_or_ambiguous_data(self):
        for raw in (
            'QF_FAILURE=private:1', 'QF_FAILURE=0:1', 'QF_FAILURE=256:1',
            'QF_FAILURE=1:0', 'QF_FAILURE=1:99999',
            'QF_FAILURE=1:10\nQF_FAILURE=1:11',
            'QF_FAILURE=1:10 private data',
        ):
            with self.subTest(raw=raw):
                self.assertEqual(promote_release.remote_failure_details("", raw), {})

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
