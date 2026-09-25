"""Atomically attach imported Cognito subjects to preserved Lightsail user UUIDs."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
from uuid import UUID

import psycopg

from database import options, SOURCE_ISSUER

COGNITO_ISSUER_PREFIX = "https://cognito-idp.ca-central-1.amazonaws.com/"


def load_mapping(path: Path) -> dict:
    raw = path.read_bytes()
    if len(raw) > 64 * 1024:
        raise ValueError("Identity mapping exceeds bound")
    value = json.loads(raw)
    if set(value) != {"schema", "cognito_issuer", "users"} or value["schema"] != 1:
        raise ValueError("Identity mapping envelope invalid")
    issuer = value["cognito_issuer"]
    if not isinstance(issuer, str) or not issuer.startswith(COGNITO_ISSUER_PREFIX):
        raise ValueError("Cognito issuer invalid")
    users = value["users"]
    if not isinstance(users, list) or not 1 <= len(users) <= 100:
        raise ValueError("Identity mapping user count invalid")
    seen_legacy, seen_cognito = set(), set()
    for user in users:
        if not isinstance(user, dict) or set(user) != {"legacy_user_id", "cognito_subject"}:
            raise ValueError("Identity mapping entry invalid")
        legacy = str(UUID(str(user["legacy_user_id"])))
        subject = str(UUID(str(user["cognito_subject"])))
        if legacy in seen_legacy or subject in seen_cognito:
            raise ValueError("Duplicate identity mapping")
        seen_legacy.add(legacy)
        seen_cognito.add(subject)
        user["legacy_user_id"] = legacy
        user["cognito_subject"] = subject
    return value


def reconcile(conn, value: dict, *, commit: bool) -> dict:
    users = value["users"]
    issuer = value["cognito_issuer"]
    inserted = 0
    exact = 0
    with conn.transaction():
        conn.execute("LOCK TABLE app.user_identities IN SHARE ROW EXCLUSIVE MODE")
        for item in users:
            legacy = item["legacy_user_id"]
            cognito_subject = item["cognito_subject"]
            row = conn.execute(
                """SELECT user_id FROM app.user_identities
                   WHERE issuer=%s AND subject=%s""",
                (SOURCE_ISSUER, legacy),
            ).fetchone()
            if not row:
                raise ValueError("Preserved legacy identity is missing")
            owner = str(row["user_id"])
            if owner != legacy:
                raise ValueError("Preserved legacy UUID changed")
            cognito = conn.execute(
                """SELECT user_id FROM app.user_identities
                   WHERE issuer=%s AND subject=%s""",
                (issuer, cognito_subject),
            ).fetchone()
            if cognito:
                if str(cognito["user_id"]) != owner:
                    raise ValueError("Cognito identity conflicts with another owner")
                exact += 1
                continue
            conn.execute(
                """INSERT INTO app.user_identities(issuer,subject,user_id)
                   VALUES (%s,%s,%s)""",
                (issuer, cognito_subject, owner),
            )
            inserted += 1

        count = conn.execute(
            """SELECT count(*) AS n FROM app.user_identities
               WHERE issuer=%s AND subject = ANY(%s)""",
            (issuer, [item["cognito_subject"] for item in users]),
        ).fetchone()["n"]
        if count != len(users):
            raise ValueError("Cognito identity reconciliation incomplete")
        histories = conn.execute(
            """SELECT count(*) AS n FROM app.quiz_history
               WHERE user_id = ANY(%s::uuid[])""",
            ([item["legacy_user_id"] for item in users],),
        ).fetchone()["n"]
        if not commit:
            raise psycopg.Rollback()

    return {
        "users": len(users),
        "inserted_identities": inserted,
        "existing_exact_identities": exact,
        "history_rows_for_migrated_users": histories,
    }


def run(operation: str, path: Path) -> dict:
    value = load_mapping(path)
    with psycopg.connect(**options(os.environ)) as conn:
        if operation == "dry-run":
            try:
                return reconcile(conn, value, commit=False)
            except psycopg.Rollback:
                # Re-run read-only verification so the result reflects the proposed inserts.
                with conn.transaction():
                    existing = conn.execute(
                        """SELECT count(*) AS n FROM app.user_identities
                           WHERE issuer=%s AND subject = ANY(%s)""",
                        (value["cognito_issuer"], [u["cognito_subject"] for u in value["users"]]),
                    ).fetchone()["n"]
                    histories = conn.execute(
                        """SELECT count(*) AS n FROM app.quiz_history
                           WHERE user_id = ANY(%s::uuid[])""",
                        ([u["legacy_user_id"] for u in value["users"]],),
                    ).fetchone()["n"]
                return {
                    "users": len(value["users"]),
                    "inserted_identities": len(value["users"]) - existing,
                    "existing_exact_identities": existing,
                    "history_rows_for_migrated_users": histories,
                }
        return reconcile(conn, value, commit=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["dry-run", "commit", "verify"])
    parser.add_argument("--mapping", required=True)
    args = parser.parse_args()
    result = run(args.operation, Path(args.mapping))
    if args.operation == "verify" and result["inserted_identities"] != 0:
        raise ValueError("Verification found missing Cognito identities")
    print(json.dumps({"operation": args.operation, **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print("ERROR: Cognito identity mapping stopped (" + type(error).__name__ + "); private values omitted")
        raise SystemExit(1) from None
