"""Exercise encrypted data transfer and rollback only on disposable PostgreSQL.

No real Supabase connection, auth records, data, keys or files are involved.
Every row and key is synthetic; output contains only fixed PASS/ERROR messages.
"""
from pathlib import Path
import json
import secrets
import sys
import traceback
from uuid import UUID

import psycopg

from history_transfer import (APPLICATION, SUPABASE, TransferError, export_snapshot, import_snapshot,
                              insert_rows, merge_snapshot, read_snapshot, rollback_history, seal, source_snapshot, unseal, validate)
from probe import connection_options, fixtures

ISSUER = "https://synthetic-auth.invalid/auth/v1"
ZERO_HISTORY_USER = UUID(int=3)


def expect(error_type, function):
    try:
        function()
    except error_type:
        return
    raise AssertionError("A forbidden migration operation unexpectedly succeeded")


def run():
    options, _ = connection_options()  # Exact disposable DB name/host + verified TLS.
    import os
    credentials = {"user": os.environ["PGUSER"], "password": os.environ["PGPASSWORD"]}
    with psycopg.connect(**options, **credentials) as owner, psycopg.connect(**options, **credentials) as writer:
        # No DROP IF EXISTS: refuse occupied schemas instead of replacing data.
        assert owner.execute("SELECT to_regclass('app.quiz_history') AS t").fetchone()["t"] is None
        assert owner.execute("SELECT to_regclass('public.quiz_history') AS t").fetchone()["t"] is None
        owner.execute(Path(__file__).with_name("schema.sql").read_text())
        owner.execute("CREATE SCHEMA auth")
        owner.execute("CREATE TABLE auth.users(id uuid PRIMARY KEY, private_auth_field text NOT NULL)")
        owner.execute("CREATE TABLE public.quiz_history (LIKE app.quiz_history INCLUDING ALL)")
        owner.execute("ALTER TABLE public.quiz_history ADD FOREIGN KEY(user_id) REFERENCES auth.users(id)")
        owner.execute("ALTER TABLE public.quiz_history ENABLE ROW LEVEL SECURITY")
        for user in (UUID(int=1), UUID(int=2), ZERO_HISTORY_USER):
            owner.execute("INSERT INTO auth.users VALUES (%s,'synthetic-never-export-auth-data')", (user,))
        # Start from PostgreSQL text so precision is never lost in Python JSON.
        from psycopg.types.json import Jsonb
        from probe import COLUMNS
        with owner.cursor() as cursor:
            for index, row in enumerate(fixtures()):
                row["quiz_title"] = "Révision 🧠 — 'quoted'\\line\n" + str(index)
                row["created_at"] = row["created_at"].replace(microsecond=123456)
                values = [Jsonb(row[key]) if key in ("quiz_data", "selected_answers") else row[key] for key in COLUMNS]
                cursor.execute("""INSERT INTO public.quiz_history
                    (id,user_id,quiz_title,source_filename,document_sha256,difficulty,question_type,
                     question_count,score,percentage,quiz_data,selected_answers,created_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", values)
        owner.execute("""UPDATE public.quiz_history SET quiz_data =
            '{"decimal":0.123456789012345678901234567890,"large":123456789012345678901234567890,
              "nested":{"null":null,"arr":[true,false,"é",{}]},"questions":[]}'::jsonb WHERE id=%s""", (UUID(int=100),))
        baseline = export_snapshot(owner, SUPABASE, ISSUER)
        manifest = validate(baseline)
        assert manifest["rows"] == 8 and manifest["users"] == 3
        assert manifest["per_user"][str(ZERO_HISTORY_USER)] == 0
        assert "private_auth_field" not in str(baseline) and "synthetic-never-export-auth-data" not in str(baseline)

        # Concurrent changes after the snapshot starts must not alter its reads.
        with source_snapshot(owner):
            assert owner.execute("SHOW transaction_read_only").fetchone()["transaction_read_only"] == "on"
            first = read_snapshot(owner, SUPABASE, ISSUER)
            writer.execute("UPDATE public.quiz_history SET quiz_title='concurrent change' WHERE id=%s", (UUID(int=101),))
            assert read_snapshot(owner, SUPABASE, ISSUER) == first
            with owner.transaction(force_rollback=True):
                expect(psycopg.errors.ReadOnlySqlTransaction, lambda: owner.execute("DELETE FROM public.quiz_history"))
        original = next(raw for raw in baseline["rows"] if str(UUID(int=101)) in raw)
        writer.execute("UPDATE public.quiz_history SET quiz_title=(%s::jsonb->>'quiz_title') WHERE id=%s", (original, UUID(int=101)))
        assert export_snapshot(owner, SUPABASE, ISSUER) == baseline
        print("PASS: consistent read-only export preserves all user IDs, empty histories, JSON precision, Unicode and timestamps without auth secrets")

        # A filtered application login must fail instead of producing a partial export.
        owner.execute("GRANT USAGE ON SCHEMA auth TO quizforge_app")
        owner.execute("GRANT SELECT(id) ON auth.users TO quizforge_app")
        owner.execute("GRANT SELECT ON public.quiz_history TO quizforge_app")
        password = secrets.token_urlsafe(32)
        with psycopg.ClientCursor(owner) as cursor:
            cursor.execute("ALTER ROLE quizforge_app PASSWORD %s", (password,))
        with psycopg.connect(**options, user="quizforge_app", password=password) as restricted:
            try:
                export_snapshot(restricted, SUPABASE, ISSUER)
            except psycopg.errors.InsufficientPrivilege as error:
                assert "row-level security" in str(error)
            else:
                raise AssertionError("RLS-filtered export was accepted")
        print("PASS: RLS-filtered export fails closed rather than silently omitting users' history")

        key = secrets.token_bytes(32)
        encrypted = seal(baseline, key)
        assert baseline == unseal(encrypted, key)
        expect(TransferError, lambda: unseal(encrypted, secrets.token_bytes(32)))
        expect(TransferError, lambda: unseal(encrypted[:-1] + bytes([encrypted[-1] ^ 1]), key))
        assert seal(baseline, key) != encrypted
        print("PASS: authenticated encrypted transfer rejects wrong keys and modified archives")

        report = import_snapshot(owner, unseal(encrypted, key))
        assert report["dry_run"] and report["manifest"] == manifest
        assert not export_snapshot(owner, APPLICATION, ISSUER)["users"]
        # A failure after identity inserts must roll back the entire import.
        bad = {**baseline, "rows": list(baseline["rows"])}
        bad["rows"][0] = bad["rows"][0].replace('"score": 4', '"score": 999')
        assert bad != baseline
        expect(psycopg.errors.CheckViolation, lambda: import_snapshot(owner, bad, dry_run=False))
        assert not export_snapshot(owner, APPLICATION, ISSUER)["users"]
        assert import_snapshot(owner, baseline, dry_run=False)["manifest"] == manifest
        assert import_snapshot(owner, baseline, dry_run=False)["manifest"] == manifest
        assert export_snapshot(owner, APPLICATION, ISSUER) == baseline
        print("PASS: dry run and failed import leave no partial data; committed import is lossless and exact retries are idempotent")

        # Simulate post-switch INSERT/DELETE and an administrative correction.
        owner.execute("DELETE FROM app.quiz_history WHERE id=%s", (UUID(int=100),))
        owner.execute("UPDATE app.quiz_history SET quiz_title='post-switch correction' WHERE id=%s", (UUID(int=101),))
        owner.execute("INSERT INTO app.quiz_history SELECT (jsonb_populate_record(NULL::app.quiz_history,to_jsonb(h)||jsonb_build_object('id',%s::text,'user_id',%s::text))).* FROM app.quiz_history h WHERE id=%s",
                      (str(UUID(int=200)), str(UUID(int=2)), UUID(int=102)))
        desired = export_snapshot(owner, APPLICATION, ISSUER)
        expect(TransferError, lambda: import_snapshot(owner, baseline, dry_run=False))
        # Source drift blocks rollback and cannot be overwritten even on dry run.
        writer.execute("UPDATE public.quiz_history SET quiz_title='unexpected source write' WHERE id=%s", (UUID(int=101),))
        drifted = export_snapshot(owner, SUPABASE, ISSUER)
        expect(TransferError, lambda: rollback_history(owner, baseline, desired, dry_run=False))
        assert export_snapshot(owner, SUPABASE, ISSUER) == drifted
        writer.execute("UPDATE public.quiz_history SET quiz_title=(%s::jsonb->>'quiz_title') WHERE id=%s", (original, UUID(int=101)))
        report = rollback_history(owner, baseline, desired)
        assert report["dry_run"] and (report["inserted"], report["updated"], report["deleted"]) == (1, 1, 1)
        assert export_snapshot(owner, SUPABASE, ISSUER) == baseline
        report = rollback_history(owner, baseline, unseal(seal(desired, key), key), dry_run=False)
        assert report["manifest"] == validate(desired)
        assert export_snapshot(owner, SUPABASE, ISSUER) == desired
        assert owner.execute("SELECT count(*) AS n FROM auth.users WHERE private_auth_field='synthetic-never-export-auth-data'").fetchone()["n"] == 3
        print("PASS: rollback reconciles inserts, updates and tombstones atomically, preserves auth records, and rejects source drift")

        # The live migration path must preserve unrelated Cognito-era data while
        # merging the retained Supabase UUIDs/history exactly.
        owner.execute("TRUNCATE app.quiz_history,app.user_identities,app.users CASCADE")
        unrelated = UUID(int=999)
        owner.execute("INSERT INTO app.users(id) VALUES (%s)", (unrelated,))
        owner.execute(
            "INSERT INTO app.user_identities(issuer,subject,user_id) VALUES (%s,%s,%s)",
            ("https://cognito-idp.ca-central-1.amazonaws.com/synthetic", "new-user", unrelated),
        )
        source_row = json.loads(baseline["rows"][0])
        source_row["id"] = str(UUID(int=9999))
        source_row["user_id"] = str(unrelated)
        insert_rows(owner, APPLICATION.history, [json.dumps(source_row)])
        report = merge_snapshot(owner, baseline)
        assert report["dry_run"] and report["target_users"] == 4 and report["target_rows"] == 9
        assert owner.execute("SELECT count(*) AS n FROM app.users").fetchone()["n"] == 1
        report = merge_snapshot(owner, baseline, dry_run=False)
        assert (report["inserted_users"], report["inserted_identities"], report["inserted_rows"]) == (3, 3, 8)
        assert (report["target_users"], report["target_identities"], report["target_rows"]) == (4, 4, 9)
        again = merge_snapshot(owner, baseline, dry_run=False)
        assert (again["inserted_users"], again["inserted_identities"], again["inserted_rows"]) == (0, 0, 0)
        assert owner.execute("SELECT count(*) AS n FROM app.users WHERE id=%s", (unrelated,)).fetchone()["n"] == 1
        assert owner.execute("SELECT count(*) AS n FROM app.quiz_history WHERE id=%s", (UUID(int=9999),)).fetchone()["n"] == 1
        owner.execute("UPDATE app.quiz_history SET quiz_title='conflict' WHERE id=%s", (UUID(int=100),))
        expect(TransferError, lambda: merge_snapshot(owner, baseline, dry_run=False))
        print("PASS: live merge preserves unrelated target data, is idempotent, and rejects history-ID conflicts")

        # Drop only schemas created above, after every check passes. The following
        # ordinary seed/snapshot/API rehearsal then starts from its original state.
        owner.execute("DROP TABLE public.quiz_history")
        owner.execute("DROP SCHEMA auth CASCADE")
        owner.execute("DROP SCHEMA app CASCADE")
        owner.execute("REVOKE CONNECT ON DATABASE quizforge_rehearsal FROM quizforge_app")
        owner.execute("DROP ROLE quizforge_app")
        print("PASS: synthetic export/import/rollback rehearsal complete; temporary SQL fixtures removed")


if __name__ == "__main__":
    try:
        run()
    except Exception as error:
        frames = [frame for frame in traceback.extract_tb(error.__traceback__) if frame.filename == __file__]
        print(f"ERROR: history transfer rehearsal failed ({type(error).__name__}, line {frames[-1].lineno if frames else 0})")
        sys.exit(1)
