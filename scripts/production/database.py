"""Explicit production endpoints and verified TLS; no credentials in errors."""
import os
from pathlib import Path
import re

from psycopg.rows import dict_row

SOURCE_HOST = "db.vfxmsvphgcaizqnbyjip.supabase.co"
SOURCE_ISSUER = "https://vfxmsvphgcaizqnbyjip.supabase.co/auth/v1"


def options(env, source=False):
    prefix = "SOURCE_DB_" if source else "PG"
    names = {key: prefix + key for key in ("HOST", "USER", "PASSWORD", "SSLROOTCERT")}
    names["DATABASE"] = "SOURCE_DB_NAME" if source else "PGDATABASE"
    values = {key: env.get(name, "") for key, name in names.items()}
    if source:
        expected = (values["HOST"] == SOURCE_HOST or (
            bool(re.fullmatch(r"aws-[0-9]+-ca-central-1\.pooler\.supabase\.com", values["HOST"]))
            and values["USER"] == "postgres.vfxmsvphgcaizqnbyjip"))
    elif env.get("PRODUCTION_DATABASE_TARGET", "rds") == "lightsail":
        expected = values["HOST"] == "db.quizforge.internal" and env.get("PGPORT", "5432") == "5432"
    elif env.get("PRODUCTION_DATABASE_TARGET", "rds") == "rds":
        expected = bool(re.fullmatch(r"quizforge-production\.[a-z0-9]+\.ca-central-1\.rds\.amazonaws\.com", values["HOST"]))
    else:
        expected = False
    if not expected or values["DATABASE"] != ("postgres" if source else "quizforge"):
        raise ValueError("Database is outside the reviewed migration boundary")
    if any(not value for value in values.values()) or not Path(values["SSLROOTCERT"]).is_file():
        raise ValueError("Database credentials or trusted CA are missing")
    return {"host": values["HOST"], "port": 5432, "dbname": values["DATABASE"], "user": values["USER"],
            "password": values["PASSWORD"], "sslmode": "verify-full", "sslrootcert": values["SSLROOTCERT"],
            "connect_timeout": 10, "autocommit": True, "row_factory": dict_row,
            "options": "-c statement_timeout=30000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000"}
