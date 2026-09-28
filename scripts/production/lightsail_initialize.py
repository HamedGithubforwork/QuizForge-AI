"""Explicit fresh Lightsail schema setup, with local private runtime credentials.

Run only after the permanent host is authorized and its private CA verified.
Never resets a populated schema, enables AI spending or exports source data.
"""
import base64
import os
from pathlib import Path
import secrets

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
import psycopg
from psycopg import sql

from database import options
from private_files import private_read, private_write


def initialize(env, directory):
    if env.get("PRODUCTION_DATABASE_TARGET") != "lightsail" or env.get("PGUSER") != "quizforge_owner":
        raise ValueError("Requires the explicit Lightsail owner connection")
    if directory.is_symlink() or not directory.is_dir() or directory.stat().st_mode & 0o077:
        raise ValueError("Credential destination must be a private directory")
    names = {"quizforge_app": "api.env", "quizforge_identity": "identity.env", "quizforge_generation": "generation-db.env", "quizforge_notifier": "notifier.env"}
    extra = ("web-push-public.env", "web-push-private.env")
    if any((directory / name).exists() or (directory / name).is_symlink()
           for name in (*names.values(), *extra)):
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
                variable = {"quizforge_app": "HISTORY_DB_PASSWORD", "quizforge_identity": "IDENTITY_DB_PASSWORD", "quizforge_generation": "PGPASSWORD", "quizforge_notifier": "PGPASSWORD"}[role]
                private_write(directory / filename, f"{variable}={passwords[role]}\n".encode())

            vapid = ec.generate_private_key(ec.SECP256R1())
            private_raw = vapid.private_numbers().private_value.to_bytes(32, "big")
            public_raw = vapid.public_key().public_bytes(
                Encoding.X962, PublicFormat.UncompressedPoint
            )
            encode = lambda value: base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")
            private_write(
                directory / "web-push-private.env",
                f"WEB_PUSH_VAPID_PRIVATE_KEY={encode(private_raw)}\n".encode(),
            )
            private_write(
                directory / "web-push-public.env",
                f"WEB_PUSH_VAPID_PUBLIC_KEY={encode(public_raw)}\n".encode(),
            )
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
