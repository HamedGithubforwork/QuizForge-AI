"""Trusted private-VPC setup/verification. Never exports the RDS owner password."""
import json
import os
from pathlib import Path
import secrets
import sys
from uuid import UUID

import boto3
import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from probe_fixtures import fixtures, fingerprint, insert


def options(env):
    host = env["PGHOST"]
    assert host.startswith("quizforge-integrated-staging.") and host.endswith(".ca-central-1.rds.amazonaws.com")
    assert env["PGDATABASE"] == "quizforge_rehearsal"
    return dict(host=host, dbname=env["PGDATABASE"], user=env["PGUSER"], password=env["PGPASSWORD"],
                sslmode="verify-full", sslrootcert=env["PGSSLROOTCERT"], connect_timeout=15,
                autocommit=True, row_factory=dict_row)


def main(phase):
    assert phase in ("seed", "verify")
    sm = boto3.client("secretsmanager", region_name="ca-central-1")
    bundle = json.loads(sm.get_secret_value(SecretId=os.environ["FIXTURE_SECRET"])["SecretString"])
    with psycopg.connect(**options(os.environ)) as conn:
        assert conn.execute("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()").fetchone()["ssl"]
        if phase == "seed":
            # Deny cleartext, with the same correct owner credential.
            try:
                with psycopg.connect(**{**options(os.environ), "sslmode":"disable"}):
                    pass
            except psycopg.OperationalError as error:
                assert any(s in str(error).lower() for s in ("no encryption", "ssl off"))
            else:
                raise AssertionError("Database accepted non-TLS access")
            with conn.transaction():
                conn.execute(Path("schema.sql").read_text())
                conn.execute(Path("identity_schema.sql").read_text())
                issuer = "https://cognito-idp.ca-central-1.amazonaws.com/" + bundle["pool"]
                for number in (1, 2, 3):
                    user = UUID(int=number)
                    subject = bundle["users"]["mapped"]["subject"] if number == 3 else str(user)
                    conn.execute("INSERT INTO app.users VALUES (%s)", (user,))
                    conn.execute("INSERT INTO app.user_identities VALUES (%s,%s,%s)", (issuer, subject, user))
                for row in fixtures():
                    insert(conn, row)
                passwords = {}
                for role in ("quizforge_app", "quizforge_identity"):
                    passwords[role] = secrets.token_urlsafe(32)
                    with psycopg.ClientCursor(conn) as cursor:
                        cursor.execute(sql.SQL("ALTER ROLE {} PASSWORD %s").format(sql.Identifier(role)), (passwords[role],))
            for role, env in (("quizforge_app", "APPLICATION_SECRET"), ("quizforge_identity", "IDENTITY_SECRET")):
                sm.put_secret_value(SecretId=os.environ[env], SecretString=json.dumps({"password":passwords[role]}))
            print("PASS: private RDS verified TLS, rejected cleartext, seeded synthetic history and separate restricted application roles")
        assert fingerprint(conn.execute("SELECT * FROM app.quiz_history").fetchall()) == fingerprint(fixtures())
        if phase == "verify":
            assert conn.execute("SELECT count(*) AS n FROM app.users").fetchone()["n"] == 4
            assert conn.execute("SELECT count(*) AS n FROM app.identity_challenges WHERE used_at IS NOT NULL").fetchone()["n"] == 1
            print("PASS: browser enrollment used one confirmation; eight foreign fixtures unchanged; no browser history rows remain")


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception as error:
        print(f"ERROR: integration database probe failed ({type(error).__name__}, SQLSTATE={getattr(error, 'sqlstate', None)})")
        sys.exit(1)
