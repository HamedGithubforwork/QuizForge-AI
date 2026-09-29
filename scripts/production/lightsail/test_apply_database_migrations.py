import hashlib
import io
import json
from pathlib import Path
import tarfile
import unittest

from scripts.production.lightsail import apply_database_migrations as migrations


class MigrationControllerTests(unittest.TestCase):
    def test_reviewed_migration_set_is_exact_and_hashed(self):
        items = migrations.migrations()

        self.assertEqual(
            [item["name"] for item in items],
            list(migrations.MIGRATION_FILES),
        )
        self.assertEqual(len(items), 10)

        for item in items:
            self.assertRegex(
                item["sha256"],
                r"^[a-f0-9]{64}$",
            )
            raw = (
                migrations.MIGRATION_DIR
                / item["name"]
            ).read_bytes()
            self.assertEqual(
                item["sha256"],
                hashlib.sha256(raw).hexdigest(),
            )

    def test_bundle_contains_only_reviewed_sql_and_authenticated_manifest(self):
        archive, manifest_raw = (
            migrations.make_bundle()
        )
        manifest = json.loads(
            manifest_raw
        )
        self.assertEqual(
            manifest["schema"],
            1,
        )
        self.assertEqual(
            [item["name"] for item in manifest["migrations"]],
            list(migrations.MIGRATION_FILES),
        )

        with tarfile.open(
            fileobj=io.BytesIO(archive),
            mode="r:gz",
        ) as bundle:
            members = bundle.getmembers()
            self.assertEqual(
                [member.name for member in members],
                list(migrations.MIGRATION_FILES),
            )
            self.assertTrue(
                all(
                    member.isfile()
                    and member.mode == 0o600
                    for member in members
                )
            )
            for item in manifest["migrations"]:
                raw = bundle.extractfile(
                    item["name"]
                ).read()
                self.assertEqual(
                    hashlib.sha256(raw).hexdigest(),
                    item["sha256"],
                )

    def test_remote_script_requires_backup_and_rejects_partial_schema(self):
        remote = migrations.REMOTE

        self.assertIn(
            "systemctl start quizforge-backup.service",
            remote,
        )
        self.assertIn(
            'Partial deck schema detected',
            remote,
        )
        self.assertIn(
            'Partial FSRS schema detected',
            remote,
        )
        self.assertIn(
            'Partial Web Push schema detected',
            remote,
        )
        self.assertIn(
            "quizforge_notifier",
            remote,
        )
        self.assertIn(
            "20260928_006_move_card.sql",
            remote,
        )
        self.assertIn(
            "app.move_card(uuid,uuid,uuid)",
            remote,
        )
        self.assertIn(
            "20260928_007_card_study_state.sql",
            remote,
        )
        self.assertIn(
            "20260928_008_card_tags.sql",
            remote,
        )
        self.assertIn(
            "20260928_009_deck_exam_date.sql",
            remote,
        )
        self.assertIn(
            "exam_date",
            remote,
        )
        self.assertIn(
            "20260929_010_deck_study_intensity.sql",
            remote,
        )
        self.assertIn(
            "study_intensity",
            remote,
        )
        self.assertIn(
            "cards_tags_gin_idx",
            remote,
        )
        self.assertIn(
            "Partial card study-state schema detected",
            remote,
        )
        self.assertIn(
            "progress_reset_at",
            remote,
        )
        self.assertIn(
            "/etc/quizforge/notifier.env",
            remote,
        )
        self.assertIn(
            "/etc/quizforge/web-push-private.env",
            remote,
        )
        self.assertIn(
            "/etc/quizforge/web-push-public.env",
            remote,
        )
        self.assertIn(
            "WEB_PUSH_VAPID_PRIVATE_KEY",
            remote,
        )
        self.assertIn(
            "WEB_PUSH_VAPID_PUBLIC_KEY",
            remote,
        )
        self.assertNotIn(
            'print(private_value)',
            remote,
        )
        self.assertIn(
            "systemctl start quizforge-backup.service",
            remote,
        )
        self.assertIn(
            "rolbypassrls",
            remote,
        )
        self.assertNotIn(
            "DROP TABLE",
            remote,
        )
        self.assertNotIn(
            "DROP SCHEMA",
            remote,
        )

    def test_result_marker_parser_accepts_plain_and_prefixed_lines(self):
        payload = '{"ok":true}'
        self.assertEqual(
            migrations.extract_qf_results(
                "notice\nQF_RESULT=" + payload + "\n"
            ),
            [payload],
        )
        self.assertEqual(
            migrations.extract_qf_results(
                "remote-prefix QF_RESULT=" + payload + "\n"
            ),
            [payload],
        )

    def test_result_marker_parser_counts_multiple_markers(self):
        self.assertEqual(
            migrations.extract_qf_results(
                "QF_RESULT={}\nQF_RESULT={}\n"
            ),
            ["{}", "{}"],
        )

    def test_combined_result_parser_accepts_stderr_transport(self):
        payload = '{"ok":true}'
        self.assertEqual(
            migrations.combined_qf_results(
                "",
                "sudo-note\nQF_RESULT=" + payload + "\n",
            ),
            [payload],
        )

    def test_combined_result_parser_deduplicates_mirrored_marker(self):
        payload = '{"ok":true}'
        line = "QF_RESULT=" + payload + "\n"
        self.assertEqual(
            migrations.combined_qf_results(
                line,
                line,
            ),
            [payload],
        )

    def test_remote_success_fallback_requires_zero_exit_path(self):
        source = Path(
            "scripts/production/lightsail/apply_database_migrations.py"
        ).read_text()
        self.assertIn(
            "result_transport_fallback_used",
            source,
        )
        self.assertIn(
            '"backup_completed_before_migration": True',
            source,
        )
        self.assertIn(
            '"all_postconditions_verified": True',
            source,
        )
        self.assertIn(
            "check=True",
            source,
        )
        self.assertIn(
            'REMOTE = r"""set -euo pipefail',
            source,
        )

    def test_summary_codes_are_bounded(self):
        self.assertEqual(
            migrations.safe_code(
                "AccessDeniedException"
            ),
            "AccessDeniedException",
        )
        self.assertEqual(
            migrations.safe_code(
                "bad value with spaces"
            ),
            "UNKNOWN",
        )


if __name__ == "__main__":
    unittest.main()
