import hashlib
import io
import json
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
        self.assertEqual(len(items), 3)

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
            "relbypassrls",
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
