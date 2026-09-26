"""Explicit fresh Lightsail schema setup, with local private runtime credentials.

Run only after the permanent host is authorized and its private CA verified.
Never resets a populated schema, enables AI spending or exports source data.
"""
import os
from pathlib import Path
import secrets

import psycopg
from psycopg import sql

from database import options
from private_files import private_read, private_write


def initialize(env, directory):
    if env.get("PRODUCTION_DATABASE_TARGET") != "lightsail" or env.get("PGUSER") != "quizforge_owner":
        raise ValueError("Requires the explicit Lightsail owner connection")
    if directory.is_symlink() or not directory.is_dir() or directory.stat().st_mode & 0o077:
        raise ValueError("Credential destination must be a private directory")
    names = {"quizforge_app": "api.env", "quizforge_identity": "identity.env", "quizforge_generation": "generation-db.env"}
    if any((directory / name).exists() or (directory / name).is_symlink() for name in names.values()):
        raise ValueError("Refusing to overwrite runtime credentials")
    passwords = {role: secrets.token_urlsafe(48) for role in names}
    with psycopg.connect(**options(env)) as conn:
        if conn.execute("SELECT 1 FROM pg_namespace WHERE nspname IN ('app','billing')").fetchone():
            raise ValueError("Database is not fresh; use the reviewed recovery procedure")
        with conn.transaction():
            conn.execute(Path(__file__).with_name("schema.sql").read_text())
            conn.execute(Path(__file__).with_name("generation_budget.sql").read_text())
            for role, filename in names.items():
                with psycopg.ClientCursor(conn) as cursor:
                    cursor.execute(sql.SQL("ALTER ROLE {} PASSWORD %s").format(sql.Identifier(role)), (passwords[role],))
                variable = {"quizforge_app": "HISTORY_DB_PASSWORD", "quizforge_identity": "IDENTITY_DB_PASSWORD", "quizforge_generation": "PGPASSWORD"}[role]
                private_write(directory / filename, f"{variable}={passwords[role]}\n".encode())
    # Files are deliberately retained on a failure for operator reconciliation;
    # a repeat attempt never replaces a possibly committed credential.


if __name__ == "__main__":
    try:
        env = dict(os.environ)
        env["PGPASSWORD"] = private_read(Path("/etc/quizforge/postgres/owner-password"), 256).decode().strip()
        initialize(env, Path("/etc/quizforge"))
        print("Fresh schema initialized; model policy remains disabled")
    except Exception as error:
        print("Initialization stopped: " + type(error).__name__)
        raise SystemExit(1) from None
