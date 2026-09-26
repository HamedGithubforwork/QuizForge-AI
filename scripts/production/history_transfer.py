"""Bounded, encrypted history snapshots. No production connections or CLI writes.

Callers own verified-TLS connections and secret delivery. Export reads one stable
snapshot; import/rollback require an idle owner connection and an explicit layout.
Only the disposable rehearsal calls mutation functions today.
"""
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import secrets
from urllib.parse import urlsplit
from uuid import UUID

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from psycopg import sql
from psycopg.pq import TransactionStatus

COLUMNS = ("id", "user_id", "quiz_title", "source_filename", "document_sha256", "difficulty",
           "question_type", "question_count", "score", "percentage", "quiz_data", "selected_answers", "created_at")
MAX_BYTES = 32 * 1024 * 1024
MAX_RECORDS = 100_000
HEADER = b"QuizForge-history-v1\0"


class TransferError(Exception):
    """Fixed messages only: never include row values, credentials or SQL errors."""


@dataclass(frozen=True)
class Layout:
    history_schema: str
    user_schema: str
    application: bool = False

    @property
    def history(self): return sql.Identifier(self.history_schema, "quiz_history")

    @property
    def users(self): return sql.Identifier(self.user_schema, "users")

    @property
    def identities(self): return sql.Identifier(self.user_schema, "user_identities")


SUPABASE = Layout("public", "auth")
APPLICATION = Layout("app", "app", True)


def require(condition, message):
    if not condition: raise TransferError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def validate(snapshot):
    require(isinstance(snapshot, dict) and set(snapshot) == {"version", "issuer", "users", "rows"}, "Invalid snapshot structure")
    require(type(snapshot["version"]) is int and snapshot["version"] == 1, "Unsupported snapshot version")
    issuer = urlsplit(snapshot["issuer"])
    require(issuer.scheme == "https" and bool(issuer.hostname) and not issuer.username
            and not issuer.password and not issuer.query and not issuer.fragment, "Invalid identity issuer")
    users, rows = snapshot["users"], snapshot["rows"]
    require(isinstance(users, list) and isinstance(rows, list) and len(users) <= MAX_RECORDS
            and len(rows) <= MAX_RECORDS, "Snapshot record limit exceeded")
    require(users == sorted(set(users)) and all(str(UUID(user)) == user for user in users), "Invalid or duplicate identities")
    user_set = set(users)
    owners, ids = Counter(), []
    for raw in rows:
        require(isinstance(raw, str), "History records must retain PostgreSQL JSON text")
        # This decoding is only for IDs/field validation. Original JSON text is
        # always imported verbatim: arbitrary-precision JSON numbers stay intact.
        row = json.loads(raw)
        require(isinstance(row, dict) and set(row) == set(COLUMNS), "Unexpected history columns")
        require(str(UUID(row["id"])) == row["id"] and row["user_id"] in user_set, "Invalid history identity")
        ids.append(row["id"])
        owners[row["user_id"]] += 1
    require(ids == sorted(set(ids)), "History IDs must be unique and ordered")
    require(len(canonical(snapshot)) <= MAX_BYTES, "Snapshot byte limit exceeded")
    return {"users": len(users), "rows": len(rows), "per_user": {user: owners[user] for user in users},
            "sha256": hashlib.sha256(canonical(snapshot)).hexdigest()}


def seal(snapshot, key):
    validate(snapshot)
    require(len(key) == 32, "A separate 256-bit encryption key is required")
    nonce = secrets.token_bytes(12)
    return HEADER + nonce + AESGCM(key).encrypt(nonce, canonical(snapshot), HEADER)


def unseal(encrypted, key):
    require(len(key) == 32 and len(encrypted) <= MAX_BYTES + len(HEADER) + 28
            and encrypted.startswith(HEADER), "Invalid encrypted snapshot")
    offset = len(HEADER)
    try:
        payload = AESGCM(key).decrypt(encrypted[offset:offset + 12], encrypted[offset + 12:], HEADER)
        snapshot = json.loads(payload)
        validate(snapshot)
        return snapshot
    except Exception:
        raise TransferError("Snapshot authentication or validation failed") from None


def idle(conn):
    require(conn.info.transaction_status == TransactionStatus.IDLE, "An idle dedicated connection is required")


def session(conn):
    conn.execute("SET LOCAL search_path = pg_catalog")
    conn.execute("SET LOCAL timezone = 'UTC'")
    conn.execute("SET LOCAL statement_timeout = '30s'")
    conn.execute("SET LOCAL lock_timeout = '5s'")
    # Does NOT bypass RLS: it makes PostgreSQL reject reads that would be filtered.
    conn.execute("SET LOCAL row_security = off")


def read_snapshot(conn, layout, issuer):
    fields = conn.execute("SELECT column_name FROM information_schema.columns WHERE table_schema=%s AND table_name='quiz_history'",
                          (layout.history_schema,)).fetchall()
    require({field["column_name"] for field in fields} == set(COLUMNS), "History schema drift requires a reviewed migration")
    columns = sql.SQL(",").join(map(sql.Identifier, COLUMNS))
    query = sql.SQL("SELECT to_jsonb(h)::text AS record FROM (SELECT {} FROM {}) h ORDER BY h.id").format(columns, layout.history)
    counts = conn.execute(sql.SQL("SELECT count(*) AS n, coalesce(sum(octet_length(to_jsonb(h)::text)),0) AS bytes FROM (SELECT {} FROM {}) h").format(columns, layout.history)).fetchone()
    user_count = conn.execute(sql.SQL("SELECT count(*) AS n FROM {}").format(layout.users)).fetchone()["n"]
    require(counts["n"] <= MAX_RECORDS and user_count <= MAX_RECORDS and counts["bytes"] <= MAX_BYTES,
            "Source exceeds bounded rehearsal export size")
    users = [str(row["id"]) for row in conn.execute(sql.SQL("SELECT id FROM {} ORDER BY id").format(layout.users))]
    if layout.application:
        identities = conn.execute(sql.SQL("SELECT subject,user_id FROM {} WHERE issuer=%s ORDER BY user_id").format(layout.identities), (issuer,)).fetchall()
        require([(row["subject"], str(row["user_id"])) for row in identities] == [(user, user) for user in users],
                "Every user needs one preserved Supabase identity for this transfer")
    snapshot = {"version": 1, "issuer": issuer, "users": users,
                "rows": [row["record"] for row in conn.execute(query)]}
    validate(snapshot)
    return snapshot


@contextmanager
def source_snapshot(conn):
    idle(conn)
    with conn.transaction():
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        session(conn)
        yield


def export_snapshot(conn, layout, issuer):
    with source_snapshot(conn):
        return read_snapshot(conn, layout, issuer)


def lock_target(conn, layout):
    tables = [layout.history, layout.users]
    if layout.application: tables.append(layout.identities)
    conn.execute(sql.SQL("LOCK TABLE {} IN SHARE ROW EXCLUSIVE MODE").format(sql.SQL(",").join(tables)))


def insert_rows(conn, table, rows):
    columns = sql.SQL(",").join(map(sql.Identifier, COLUMNS))
    statement = sql.SQL("INSERT INTO {} ({}) SELECT {} FROM jsonb_populate_record(NULL::{}, %s::jsonb)").format(table, columns, columns, table)
    with conn.cursor() as cursor:
        cursor.executemany(statement, [(raw,) for raw in rows])


def reconcile(conn, layout, snapshot):
    actual = read_snapshot(conn, layout, snapshot["issuer"])
    require(validate(actual) == validate(snapshot), "Reconciliation failed; transaction will not commit")
    return validate(actual)


def import_snapshot(conn, snapshot, *, dry_run=True):
    """Import into an empty application schema; an exact repeat is a no-op."""
    validate(snapshot)
    idle(conn)
    with conn.transaction(force_rollback=dry_run):
        session(conn)
        lock_target(conn, APPLICATION)
        counts = [conn.execute(sql.SQL("SELECT count(*) AS n FROM {}").format(table)).fetchone()["n"]
                  for table in (APPLICATION.history, APPLICATION.users, APPLICATION.identities)]
        if any(counts):
            require(counts[2] == len(snapshot["users"]), "Nonempty destination requires exact identity coverage")
            report = reconcile(conn, APPLICATION, snapshot)
        else:
            with conn.cursor() as cursor:
                cursor.executemany("INSERT INTO app.users(id) VALUES (%s)", [(user,) for user in snapshot["users"]])
                cursor.executemany("INSERT INTO app.user_identities(issuer,subject,user_id) VALUES (%s,%s,%s)",
                                   [(snapshot["issuer"], user, user) for user in snapshot["users"]])
            insert_rows(conn, APPLICATION.history, snapshot["rows"])
            report = reconcile(conn, APPLICATION, snapshot)
    return {"dry_run": dry_run, "manifest": report}


def merge_snapshot(conn, snapshot, *, dry_run=True):
    """Merge one verified Supabase snapshot without overwriting unrelated target data.

    Existing Cognito-only users/history are preserved. Source UUID collisions with
    unrelated identities and history-ID content conflicts fail closed.
    """
    manifest = validate(snapshot)
    idle(conn)
    users = [UUID(user) for user in snapshot["users"]]
    rows_by_id = {UUID(json.loads(raw)["id"]): raw for raw in snapshot["rows"]}

    with conn.transaction(force_rollback=dry_run):
        session(conn)
        lock_target(conn, APPLICATION)

        existing_users = {
            str(row["id"])
            for row in conn.execute(
                "SELECT id FROM app.users WHERE id = ANY(%s)",
                (users,),
            )
        }

        identity_rows = conn.execute(
            """SELECT issuer,subject,user_id
               FROM app.user_identities
               WHERE issuer=%s AND subject = ANY(%s)
               ORDER BY subject""",
            (snapshot["issuer"], snapshot["users"]),
        ).fetchall()
        identity_by_subject = {row["subject"]: str(row["user_id"]) for row in identity_rows}
        require(
            all(identity_by_subject.get(subject, subject) == subject for subject in identity_by_subject),
            "Existing Supabase identity maps to a different internal user",
        )

        related = conn.execute(
            """SELECT issuer,subject,user_id
               FROM app.user_identities
               WHERE user_id = ANY(%s)
               ORDER BY user_id,issuer,subject""",
            (users,),
        ).fetchall()
        identities_for_user = {}
        for row in related:
            identities_for_user.setdefault(str(row["user_id"]), []).append((row["issuer"], row["subject"]))
        for user in existing_users:
            if user not in identity_by_subject and identities_for_user.get(user):
                require(False, "Existing destination UUID has unrelated identity")

        missing_users = [user for user in snapshot["users"] if user not in existing_users]
        with conn.cursor() as cursor:
            cursor.executemany("INSERT INTO app.users(id) VALUES (%s)", [(user,) for user in missing_users])

        missing_identities = [
            user for user in snapshot["users"] if user not in identity_by_subject
        ]
        with conn.cursor() as cursor:
            cursor.executemany(
                "INSERT INTO app.user_identities(issuer,subject,user_id) VALUES (%s,%s,%s)",
                [(snapshot["issuer"], user, user) for user in missing_identities],
            )

        existing_history = {}
        if rows_by_id:
            ids = list(rows_by_id)
            columns = sql.SQL(",").join(map(sql.Identifier, COLUMNS))
            query = sql.SQL(
                "SELECT id,to_jsonb(h)::text AS record FROM (SELECT {} FROM {} WHERE id = ANY(%s)) h"
            ).format(columns, APPLICATION.history)
            existing_history = {
                row["id"]: row["record"]
                for row in conn.execute(query, (ids,))
            }
            for row_id, raw in existing_history.items():
                require(rows_by_id[row_id] == raw, "Existing destination history ID conflicts with source")

        missing_rows = [raw for row_id, raw in rows_by_id.items() if row_id not in existing_history]
        insert_rows(conn, APPLICATION.history, missing_rows)

        actual_users = {
            str(row["id"])
            for row in conn.execute("SELECT id FROM app.users WHERE id = ANY(%s)", (users,))
        }
        require(actual_users == set(snapshot["users"]), "Migrated user coverage mismatch")

        actual_identities = {
            row["subject"]: str(row["user_id"])
            for row in conn.execute(
                """SELECT subject,user_id FROM app.user_identities
                   WHERE issuer=%s AND subject = ANY(%s)""",
                (snapshot["issuer"], snapshot["users"]),
            )
        }
        require(
            actual_identities == {user: user for user in snapshot["users"]},
            "Migrated identity coverage mismatch",
        )

        actual_history = {}
        if rows_by_id:
            columns = sql.SQL(",").join(map(sql.Identifier, COLUMNS))
            query = sql.SQL(
                "SELECT id,to_jsonb(h)::text AS record FROM (SELECT {} FROM {} WHERE id = ANY(%s)) h"
            ).format(columns, APPLICATION.history)
            actual_history = {
                row["id"]: row["record"]
                for row in conn.execute(query, (list(rows_by_id),))
            }
        require(actual_history == rows_by_id, "Migrated history reconciliation mismatch")

        totals = conn.execute(
            """SELECT
                 (SELECT count(*) FROM app.users) AS users,
                 (SELECT count(*) FROM app.user_identities) AS identities,
                 (SELECT count(*) FROM app.quiz_history) AS rows"""
        ).fetchone()

    return {
        "dry_run": dry_run,
        "manifest": manifest,
        "inserted_users": len(missing_users),
        "inserted_identities": len(missing_identities),
        "inserted_rows": len(missing_rows),
        "existing_exact_rows": len(existing_history),
        "target_users": totals["users"],
        "target_identities": totals["identities"],
        "target_rows": totals["rows"],
    }


def rollback_history(conn, baseline, desired, *, dry_run=True):
    """Reconcile retained Supabase history only if it still exactly matches baseline.

    No auth tables are changed. New/unmapped users or source drift abort. This is
    an offline/frozen-writer migration operation, never an application endpoint.
    """
    validate(baseline)
    validate(desired)
    require(baseline["issuer"] == desired["issuer"] and baseline["users"] == desired["users"],
            "Rollback requires unchanged, mapped Supabase identities")
    idle(conn)
    with conn.transaction(force_rollback=dry_run):
        session(conn)
        lock_target(conn, SUPABASE)
        reconcile(conn, SUPABASE, baseline)
        old = {json.loads(raw)["id"]: raw for raw in baseline["rows"]}
        new = {json.loads(raw)["id"]: raw for raw in desired["rows"]}
        removed, added = old.keys() - new.keys(), new.keys() - old.keys()
        changed = {key for key in old.keys() & new.keys() if old[key] != new[key]}
        with conn.cursor() as cursor:
            cursor.executemany("DELETE FROM public.quiz_history WHERE id=%s", [(key,) for key in removed])
            columns = sql.SQL(",").join(sql.Identifier(column) for column in COLUMNS if column != "id")
            statement = sql.SQL("UPDATE public.quiz_history SET ({}) = (SELECT {} FROM jsonb_populate_record(NULL::public.quiz_history,%s::jsonb)) WHERE id=%s").format(columns, columns)
            cursor.executemany(statement, [(new[key], key) for key in changed])
        insert_rows(conn, SUPABASE.history, [new[key] for key in sorted(added)])
        report = reconcile(conn, SUPABASE, desired)
    return {"dry_run": dry_run, "inserted": len(added), "updated": len(changed), "deleted": len(removed), "manifest": report}
