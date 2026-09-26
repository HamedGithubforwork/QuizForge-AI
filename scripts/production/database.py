"""Explicit production endpoints and verified TLS; no credentials in errors."""
from pathlib import Path
import re

from psycopg.rows import dict_row


def options(env):
    values = {key: env.get("PG" + key, "") for key in ("HOST", "DATABASE", "USER", "PASSWORD", "SSLROOTCERT")}
    target = env.get("PRODUCTION_DATABASE_TARGET", "rds")
    if target == "lightsail":
        expected = values["HOST"] == "db.quizforge.internal" and env.get("PGPORT", "5432") == "5432"
    elif target == "rds":
        expected = bool(re.fullmatch(r"quizforge-production\.[a-z0-9]+\.ca-central-1\.rds\.amazonaws\.com", values["HOST"]))
    else:
        expected = False
    if not expected or values["DATABASE"] != "quizforge":
        raise ValueError("Database is outside the reviewed production boundary")
    if any(not value for value in values.values()) or not Path(values["SSLROOTCERT"]).is_file():
        raise ValueError("Database credentials or trusted CA are missing")
    return {"host": values["HOST"], "port": 5432, "dbname": values["DATABASE"], "user": values["USER"],
            "password": values["PASSWORD"], "sslmode": "verify-full", "sslrootcert": values["SSLROOTCERT"],
            "connect_timeout": 10, "autocommit": True, "row_factory": dict_row,
            "options": "-c statement_timeout=30000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000"}
