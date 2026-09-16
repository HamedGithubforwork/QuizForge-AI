"""Synthetic migration and security rehearsal; no production connection/data.

ECS injects the RDS-managed owner secret. A fresh application password exists
only in process memory and database authentication storage. Never log either.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import uuid

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

USERS = [uuid.UUID(int=1), uuid.UUID(int=2)]
ISSUER = "https://synthetic-auth.invalid"
COLUMNS = ("id", "user_id", "quiz_title", "source_filename", "document_sha256", "difficulty",
           "question_type", "question_count", "score", "percentage", "quiz_data", "selected_answers", "created_at")


def fixtures():
    return [{"id": uuid.UUID(int=100 + index), "user_id": USERS[index // 4],
             "quiz_title": f"Synthetic imported quiz {index}", "source_filename": "synthetic.pdf",
             "document_sha256": "a" * 64 if index % 2 else None, "difficulty": "easy",
             "question_type": "multiple_choice", "question_count": 5, "score": 4, "percentage": 80,
             "quiz_data": {"title": f"Synthetic imported quiz {index}", "questions": []},
             "selected_answers": {"0": 1}, "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc)}
            for index in range(8)]


def fingerprint(rows):
    # Preserve PostgreSQL timestamp precision, UUIDs, JSON and null document hashes.
    normalized = [{key: str(value) if isinstance(value, uuid.UUID) else
                   value.astimezone(timezone.utc).isoformat() if isinstance(value, datetime) else value
                   for key, value in row.items()} for row in sorted(rows, key=lambda r: str(r["id"]))]
    return hashlib.sha256(json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def connection_options():
    host = os.environ["PGHOST"]
    local = os.getenv("RDS_REHEARSAL_LOCAL") == "1"
    if local:
        assert host == "127.0.0.1", "Local CI may only use loopback"
        tls = {"sslmode": "disable"}
    else:
        assert host.startswith("quizforge-rds-rehearsal.") or host.startswith("quizforge-rds-rehearsal-restore.")
        assert host.endswith(".ca-central-1.rds.amazonaws.com"), "Unexpected database host"
        tls = {"sslmode": "verify-full", "sslrootcert": os.environ["PGSSLROOTCERT"]}
    assert os.environ["PGDATABASE"] == "quizforge_rehearsal"
    return {"host": host, "port": 5432, "dbname": "quizforge_rehearsal", "connect_timeout": 15,
            "autocommit": True, "row_factory": dict_row, **tls}, local


def insert(conn, row):
    values = [Jsonb(row[key]) if key in ("quiz_data", "selected_answers") else row[key] for key in COLUMNS]
    conn.execute("""INSERT INTO app.quiz_history
        (id,user_id,quiz_title,source_filename,document_sha256,difficulty,question_type,
         question_count,score,percentage,quiz_data,selected_answers,created_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", values)


@contextmanager
def identity(conn, user):
    # A real backend must supply these values only after bearer-token validation.
    with conn.transaction():
        conn.execute("SELECT set_config('quizforge.auth_issuer', %s, true)", (ISSUER,))
        conn.execute("SELECT set_config('quizforge.auth_subject', %s, true)", (str(user),))
        rows = conn.execute("SELECT user_id FROM app.user_identities").fetchall()
        assert rows == [{"user_id": user}]
        conn.execute("SELECT set_config('quizforge.user_id', %s, true)", (str(rows[0]["user_id"]),))
        yield


def denied(conn, operation):
    try:
        with conn.transaction():
            operation()
    except psycopg.errors.InsufficientPrivilege:
        return
    raise AssertionError("Application role accepted a forbidden operation")


def verify_application_role(app, owner, local):
    role = app.execute("SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user").fetchone()
    assert not any(role.values())
    assert app.execute("SELECT current_user AS name").fetchone()["name"] == "quizforge_app"
    assert not owner.execute("SELECT 1 FROM pg_tables WHERE schemaname='app' AND tableowner='quizforge_app'").fetchall()
    if not local:
        assert app.execute("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()").fetchone()["ssl"]
    assert app.execute("SELECT * FROM app.quiz_history").fetchall() == []
    assert app.execute("SELECT * FROM app.user_identities").fetchall() == []
    for user in USERS:
        with identity(app, user):
            # Deliberately omit an owner WHERE predicate to prove database RLS.
            rows = app.execute("SELECT * FROM app.quiz_history ORDER BY created_at DESC,id DESC").fetchall()
            assert len(rows) == 4 and all(row["user_id"] == user for row in rows)
            first = app.execute("SELECT * FROM app.quiz_history WHERE user_id=%s ORDER BY created_at DESC,id DESC LIMIT 2", (user,)).fetchall()
            last = first[-1]
            second = app.execute("SELECT * FROM app.quiz_history WHERE user_id=%s AND (created_at,id)<(%s,%s) ORDER BY created_at DESC,id DESC LIMIT 2",
                                 (user, last["created_at"], last["id"])).fetchall()
            assert first + second == rows
            document_rows = app.execute("SELECT * FROM app.quiz_history WHERE user_id=%s AND document_sha256=%s", (user, "a" * 64)).fetchall()
            assert len(document_rows) == 2
            other = USERS[1] if user == USERS[0] else USERS[0]
            assert app.execute("DELETE FROM app.quiz_history WHERE user_id=%s", (other,)).rowcount == 0
            forged = {**fixtures()[0], "id": uuid.uuid4(), "user_id": other}
            denied(app, lambda: insert(app, forged))
            for statement in ("UPDATE app.quiz_history SET score=0", "TRUNCATE app.quiz_history",
                              "CREATE TABLE app.forbidden(id int)", "ALTER TABLE app.quiz_history DISABLE ROW LEVEL SECURITY",
                              "CREATE TABLE public.forbidden(id int)", "CREATE ROLE forbidden"):
                denied(app, lambda statement=statement: app.execute(statement))
            saved = {**fixtures()[0], "id": uuid.uuid4(), "user_id": user}
            insert(app, saved)
            assert app.execute("SELECT count(*) AS n FROM app.quiz_history").fetchone()["n"] == 5
            assert app.execute("DELETE FROM app.quiz_history WHERE id=%s", (saved["id"],)).rowcount == 1
        # Reuse the same physical connection for both users and no identity.
        assert app.execute("SELECT * FROM app.quiz_history").fetchall() == []
        assert app.execute("SELECT * FROM app.user_identities").fetchall() == []
    try:
        with identity(app, USERS[0]):
            raise RuntimeError("Deliberate rollback to test context reset")
    except RuntimeError:
        pass
    assert app.execute("SELECT * FROM app.quiz_history").fetchall() == []
    print("PASS: application role CRUD, owner isolation, privilege denials, cursor ordering and connection identity reset")


def main(phase):
    assert phase in ("seed", "verify-restored")
    options, local = connection_options()
    with psycopg.connect(**options, user=os.environ["PGUSER"], password=os.environ["PGPASSWORD"]) as owner:
        if not local:
            # rds.force_ssl is an RDS parameter, checked through its API by control.py.
            # PostgreSQL's own SSL support and actual connection enforcement are checked here.
            assert owner.execute("SHOW ssl").fetchone()["ssl"] == "on"
            assert owner.execute("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()").fetchone()["ssl"]
            try:
                with psycopg.connect(**{**options, "sslmode": "disable"},
                                     user=os.environ["PGUSER"], password=os.environ["PGPASSWORD"]):
                    pass
            except psycopg.OperationalError as error:
                assert any(message in str(error).lower() for message in ("no encryption", "ssl off")), "Unexpected non-TLS failure"
            else:
                raise AssertionError("Database accepted an unencrypted connection")
            print("PASS: verified TLS connection and explicit rejection of non-TLS access")
        if phase == "seed":
            with owner.transaction():
                owner.execute(Path(__file__).with_name("schema.sql").read_text())
                for user in USERS:
                    owner.execute("INSERT INTO app.users(id) VALUES (%s)", (user,))
                    owner.execute("INSERT INTO app.user_identities(issuer,subject,user_id) VALUES (%s,%s,%s)", (ISSUER, str(user), user))
                for row in fixtures():
                    insert(owner, row)
        expected = fingerprint(fixtures())
        before = owner.execute("SELECT * FROM app.quiz_history").fetchall()
        assert fingerprint(before) == expected
        assert owner.execute("SELECT count(*) AS n FROM app.users").fetchone()["n"] == 2
        assert owner.execute("SELECT count(*) AS n FROM app.user_identities").fetchone()["n"] == 2
        print(f"PASS: {phase} reconciled 8 rows, 2 users, identities, UUIDs, timestamps, hashes and JSON checksum {expected}")
        password = secrets.token_urlsafe(32)
        # PostgreSQL utility statements need client-side parameter binding.
        # Psycopg's ClientCursor quotes the value; no SQL text is interpolated here.
        with psycopg.ClientCursor(owner) as cursor:
            cursor.execute("ALTER ROLE quizforge_app PASSWORD %s", (password,))
        with psycopg.connect(**options, user="quizforge_app", password=password) as app:
            verify_application_role(app, owner, local)
        assert fingerprint(owner.execute("SELECT * FROM app.quiz_history").fetchall()) == expected
    print(f"PASS: {phase} PostgreSQL rehearsal complete")


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception as error:
        # psycopg exception details can include statements and connection data.
        print(f"ERROR: PostgreSQL rehearsal failed ({type(error).__name__}, SQLSTATE={getattr(error, 'sqlstate', None)})")
        sys.exit(1)
