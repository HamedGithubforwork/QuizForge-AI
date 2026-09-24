import copy
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from cryptography.exceptions import InvalidTag
import psycopg

import lightsail_backup as backup


def synthetic_snapshot():
    value = {"format": backup.FORMAT, "created_at": "2026-09-21T00:00:00+00:00",
             "schema": "a" * 64, "tables": {t: [] for t in backup.TABLES}}
    value["sha256"] = backup.digest(value)
    return value


class BackupBoundaries(unittest.TestCase):
    def test_authenticated_encryption_rejects_corruption_truncation_wrong_key_and_plaintext(self):
        key = secrets.token_bytes(32)
        snapshot = synthetic_snapshot()
        archive = backup.seal(snapshot, key)
        self.assertEqual(backup.unseal(archive, key), snapshot)
        self.assertNotEqual(archive, backup.seal(snapshot, key))
        for bad, secret in ((archive[:-1], key), (archive[:-1] + bytes([archive[-1] ^ 1]), key),
                            (archive, secrets.token_bytes(32)), (backup.canonical(snapshot), key),
                            (b"wrong" + archive[5:], key)):
            with self.subTest(size=len(bad)), self.assertRaises((ValueError, InvalidTag)):
                backup.unseal(bad, secret)

    def test_archive_format_digest_and_size_are_verified(self):
        for update in ({"format": "future"}, {"sha256": "b" * 64}, {"schema": "bad"},
                       {"tables": {}}, {"created_at": "unknown"}):
            with self.subTest(update=update), self.assertRaises(ValueError):
                backup.validate(synthetic_snapshot() | update)
        with patch.object(backup, "MAX_BYTES", 50), self.assertRaises(ValueError):
            backup.seal(synthetic_snapshot(), secrets.token_bytes(32))

    def test_production_transport_has_no_staging_or_restore_in_place_bypass(self):
        with tempfile.NamedTemporaryFile() as ca:
            env = {"PGHOST": "db.quizforge.internal", "PGDATABASE": "quizforge", "PGUSER": "quizforge_owner",
                   "PGPASSWORD": "synthetic", "PGSSLROOTCERT": ca.name}
            self.assertEqual(backup.connection_options(env)["sslmode"], "verify-full")
            loopback = backup.connection_options(env | {"PGHOSTADDR": "127.0.0.1"})
            self.assertEqual(loopback["host"], "db.quizforge.internal")
            self.assertEqual(loopback["hostaddr"], "127.0.0.1")
            with self.assertRaises(ValueError):
                backup.connection_options(env | {"PGHOSTADDR": "203.0.113.8"})
            with self.assertRaises(ValueError): backup.connection_options(env, restore=True)
            recovery = env | {"PGHOST": "restore-db.quizforge.internal"}
            self.assertEqual(backup.connection_options(recovery, restore=True)["host"], recovery["PGHOST"])
            for change in ({"PGHOST": "127.0.0.1"}, {"PGUSER": "quizforge_app"}, {"PGDATABASE": "postgres"},
                           {"PGPORT": "5433"}, {"PGPASSWORD": ""}, {"PGSSLROOTCERT": "/absent"}):
                with self.subTest(change=change), self.assertRaises(ValueError):
                    backup.connection_options(env | change)

    def test_offsite_upload_requires_versioning_and_uses_conditional_content_address(self):
        client = Mock()
        client.get_bucket_versioning.return_value = {"Status": "Enabled"}
        client.put_object.return_value = {"VersionId": "v1"}
        archive = backup.seal(synthetic_snapshot(), secrets.token_bytes(32))
        bucket, account = "quizforge-production-backups-123456789012", "123456789012"
        receipt = backup.upload_archive(client, bucket, account, archive)
        sent = client.put_object.call_args.kwargs
        self.assertEqual(sent["Body"], archive)
        self.assertEqual(sent["IfNoneMatch"], "*")
        self.assertEqual(sent["ExpectedBucketOwner"], account)
        self.assertEqual(sent["ServerSideEncryption"], "AES256")
        self.assertEqual(receipt["object_key"], "lightsail/" + hashlib.sha256(archive).hexdigest() + ".qflb")
        client.reset_mock()
        client.get_bucket_versioning.return_value = {"Status": "Suspended"}
        with self.assertRaises(ValueError): backup.upload_archive(client, bucket, account, archive)
        client.put_object.assert_not_called()
        with self.assertRaises(ValueError): backup.upload_archive(client, bucket, "111111111111", archive)

    def test_exact_offsite_download_detects_wrong_version_digest_and_size(self):
        archive = backup.seal(synthetic_snapshot(), secrets.token_bytes(32))
        key = "lightsail/" + hashlib.sha256(archive).hexdigest() + ".qflb"
        client = Mock()
        args = (client, "quizforge-production-backups-123456789012", "123456789012", key, "v1")
        for payload, version, size, passed in ((archive, "v1", len(archive), True),
                (archive, "v2", len(archive), False), (archive[:-1], "v1", len(archive)-1, False),
                (archive, "v1", backup.MAX_ARCHIVE_BYTES + 1, False)):
            body = io.BytesIO(payload)
            client.get_object.return_value = {"Body": body, "VersionId": version, "ContentLength": size}
            if passed:
                self.assertEqual(backup.download_archive(*args), archive)
            else:
                with self.assertRaises(ValueError): backup.download_archive(*args)
            self.assertTrue(body.closed)

    def test_commit_requires_independent_digest_before_database_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            key = secrets.token_bytes(32)
            key_path, archive_path = Path(directory) / "key", Path(directory) / "archive"
            backup.private_write(key_path, key)
            backup.private_write(archive_path, backup.seal(synthetic_snapshot(), key))
            with patch.object(backup.psycopg, "connect") as connect, self.assertRaises(ValueError):
                backup.main(["restore", "--key-file", str(key_path), "--archive", str(archive_path), "--commit"])
            connect.assert_not_called()


@unittest.skipUnless(os.environ.get("LIGHTSAIL_BACKUP_TEST_SOURCE") and os.environ.get("LIGHTSAIL_BACKUP_TEST_TARGET"),
                     "Dedicated CI PostgreSQL 17 source and isolated target required")
class PostgreSQLRecovery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = psycopg.connect(os.environ["LIGHTSAIL_BACKUP_TEST_SOURCE"], autocommit=True)
        cls.target = psycopg.connect(os.environ["LIGHTSAIL_BACKUP_TEST_TARGET"], autocommit=True)
        for conn in (cls.source, cls.target):
            if (conn.info.host != "127.0.0.1" or conn.info.dbname != "quizforge"
                    or conn.info.port not in (55431, 55432) or conn.info.server_version // 10000 != 17):
                raise ValueError("Recovery tests require exact disposable local PostgreSQL 17 services")
            for name in ("schema.sql", "generation_budget.sql"):
                conn.execute(Path(__file__).with_name(name).read_text())
        cls.source.execute("""INSERT INTO app.users VALUES
            ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002'),
            ('00000000-0000-0000-0000-000000000003');
            INSERT INTO app.user_identities VALUES
            ('legacy','old1','00000000-0000-0000-0000-000000000001'),
            ('cognito','new1','00000000-0000-0000-0000-000000000001'),
            ('cognito','new2','00000000-0000-0000-0000-000000000002');
            INSERT INTO app.quiz_history(id,user_id,quiz_title,source_filename,document_sha256,difficulty,
                question_type,question_count,score,percentage,quiz_data,selected_answers,created_at)
            VALUES ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',
                'Énergie et résumé','notes.pdf',repeat('a',64),'medium','multiple_choice',2,1,50,
                '{"precision":0.12345678901234567890123456789,"questions":["é", "biology"]}',
                '{"0":2}', '2026-09-20 23:01:02.123456+00'),
                ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002',
                'Other owner','other.pdf',NULL,'hard','short_answer',1,1,100,'{}','{}',now());
            INSERT INTO app.identity_challenges VALUES
                (repeat('b',64),'cognito','new1','legacy','old1','link',now(),NULL);
            UPDATE billing.generation_policy SET enabled=true,daily_requests=10,monthly_requests=100,monthly_nano_usd=5000000000,pricing_key='synthetic-reviewed-prices',pricing_valid_until=current_date+1;
            INSERT INTO billing.generation_usage VALUES ('day',current_date,7),
                ('month',date_trunc('month',current_date)::date,27);
            UPDATE billing.generation_usage SET accounted_nano_usd=10000000;
            INSERT INTO billing.generation_reservations VALUES
                ('20000000-0000-0000-0000-000000000001',current_date,date_trunc('month',current_date)::date,10000000,NULL)""")

    @classmethod
    def tearDownClass(cls):
        cls.source.close()
        cls.target.close()

    def setUp(self):
        self.target.execute("TRUNCATE app.identity_challenges,app.quiz_history,app.user_identities,app.users,billing.generation_usage,billing.generation_reservations")
        self.target.execute("UPDATE billing.generation_policy SET enabled=false,daily_requests=0,monthly_requests=0,monthly_nano_usd=0,pricing_key='',pricing_valid_until='1970-01-01'")
        self.snapshot = backup.export_snapshot(self.source)

    def target_rows(self):
        with self.target.transaction():
            self.target.execute("SET LOCAL timezone='UTC'")
            return backup.read_rows(self.target)

    def test_encrypted_roundtrip_dry_run_commit_content_and_security(self):
        started = time.monotonic()
        key = secrets.token_bytes(32)
        restored = backup.unseal(backup.seal(self.snapshot, key), key)
        self.assertTrue(backup.restore_snapshot(self.target, restored)["dry_run"])
        self.assertEqual(self.target_rows()["app.users"], [])
        report = backup.restore_snapshot(self.target, restored, commit=True)
        self.assertTrue(report["reconciled"])
        rows = self.target_rows()
        for table in backup.TABLES:
            if table not in ("billing.generation_policy", "app.identity_challenges"):
                self.assertEqual(rows[table], restored["tables"][table])
        self.assertEqual(rows["app.identity_challenges"], [])
        policy = json.loads(rows["billing.generation_policy"][0])
        self.assertEqual(policy, json.loads(restored["tables"]["billing.generation_policy"][0]) | {"enabled": False})
        self.assertEqual(len(rows["app.users"]), 3)  # Includes the account without history.
        with self.target.transaction():
            self.target.execute("SET LOCAL ROLE quizforge_app")
            self.target.execute("SET LOCAL quizforge.user_id='00000000-0000-0000-0000-000000000001'")
            self.assertEqual(self.target.execute("SELECT quiz_title FROM app.quiz_history").fetchall(), [('Énergie et résumé',)])
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                with self.target.transaction(): self.target.execute("DELETE FROM billing.generation_usage")
        with self.target.transaction():
            self.target.execute("SET LOCAL ROLE quizforge_generation")
            self.assertFalse(self.target.execute("SELECT billing.reserve_generation()").fetchone()[0])
        print(json.dumps({"synthetic_restore_seconds": round(time.monotonic() - started, 3),
                          "users": 3, "history_rows": 2, "reconciled": True,
                          "ownership_enforced": True, "spending_disabled": True}))

    def test_scheduled_offserver_receipt_recovers_into_separate_database_after_state_loss(self):
        import lightsail_backup_job as job
        from test_lightsail_backup_job import synthetic_s3, BUCKET, ACCOUNT
        with tempfile.TemporaryDirectory() as directory, synthetic_s3() as fixture:
            root = Path(directory) / 'state'
            key = secrets.token_bytes(32)
            job.run_backup(root, key, lambda: backup.export_snapshot(self.source), fixture.client, BUCKET, ACCOUNT)
            for file in root.iterdir(): file.unlink()
            root.rmdir()
            versions = fixture.client.list_object_versions(Bucket=BUCKET, Prefix='receipts/', ExpectedBucketOwner=ACCOUNT)['Versions']
            archive, _, receipt = job.fetch_backup(fixture.client, key, BUCKET, ACCOUNT, versions[0]['Key'], versions[0]['VersionId'])
            restored = backup.unseal(archive, key)
            self.assertEqual(restored['sha256'], receipt['content_sha256'])
            self.assertTrue(backup.restore_snapshot(self.target, restored, commit=True)['reconciled'])
            with self.target.transaction():
                self.target.execute("SET LOCAL ROLE quizforge_app")
                self.target.execute("SET LOCAL quizforge.user_id='00000000-0000-0000-0000-000000000001'")
                self.assertEqual(self.target.execute("SELECT quiz_title FROM app.quiz_history").fetchall(), [('Énergie et résumé',)])
            with self.target.transaction():
                self.target.execute("SET LOCAL ROLE quizforge_generation")
                self.assertFalse(self.target.execute("SELECT billing.reserve_generation()").fetchone()[0])

    def test_occupied_target_and_schema_or_policy_drift_leave_target_unchanged(self):
        self.target.execute("INSERT INTO app.users VALUES ('00000000-0000-0000-0000-000000000099')")
        before = self.target_rows()
        with self.assertRaises(ValueError): backup.restore_snapshot(self.target, self.snapshot, commit=True)
        self.assertEqual(self.target_rows(), before)
        self.target.execute("DELETE FROM app.users")
        self.target.execute("ALTER TABLE app.quiz_history DISABLE ROW LEVEL SECURITY")
        try:
            with self.assertRaises(ValueError): backup.restore_snapshot(self.target, self.snapshot, commit=True)
        finally:
            self.target.execute("ALTER TABLE app.quiz_history ENABLE ROW LEVEL SECURITY")
        self.assertEqual(self.target_rows()["app.users"], [])

    def test_foreign_key_failure_and_post_import_mismatch_rollback_every_insert(self):
        bad = copy.deepcopy(self.snapshot)
        bad["tables"]["app.users"] = []
        bad["sha256"] = backup.digest({k: v for k, v in bad.items() if k != "sha256"})
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            backup.restore_snapshot(self.target, bad, commit=True)
        before = self.target_rows()
        original = backup.read_rows
        calls = 0
        def mismatched(conn):
            nonlocal calls
            calls += 1
            result = original(conn)
            if calls == 2: result["app.users"] = []
            return result
        with patch.object(backup, "read_rows", side_effect=mismatched), self.assertRaises(ValueError):
            backup.restore_snapshot(self.target, self.snapshot, commit=True)
        self.assertEqual(self.target_rows(), before)

    def test_unknown_table_or_oversize_source_is_not_silently_backed_up(self):
        self.source.execute("CREATE TABLE app.future_data(value text)")
        try:
            with self.assertRaises(ValueError): backup.export_snapshot(self.source)
        finally:
            self.source.execute("DROP TABLE app.future_data")
        with patch.object(backup, "MAX_ROWS", 1), self.assertRaises(ValueError):
            backup.export_snapshot(self.source)

    def test_restricted_reader_cannot_silently_export_a_partial_rls_backup(self):
        before = backup.schema_state(self.source)
        # The first exported table exercises RLS. Do not materialize default
        # ACLs on unrelated tables: DROP OWNED does not restore a NULL ACL.
        self.source.execute("""CREATE ROLE backup_reader NOLOGIN;
            GRANT USAGE ON SCHEMA app TO backup_reader;
            GRANT SELECT ON app.users TO backup_reader;
            SET ROLE backup_reader""")
        try:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                backup.export_snapshot(self.source)
        finally:
            self.source.execute("RESET ROLE; DROP OWNED BY backup_reader; DROP ROLE backup_reader")
            self.assertEqual(backup.schema_state(self.source), before)


if __name__ == "__main__":
    unittest.main()
