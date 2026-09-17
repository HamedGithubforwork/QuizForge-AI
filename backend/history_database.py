"""Opt-in PostgreSQL lifecycle. Supabase remains the default history store."""
import logging
import os
from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool


def history_backend():
    backend = os.getenv("HISTORY_BACKEND", "supabase").strip().lower()
    if backend not in ("supabase", "postgres"):
        raise RuntimeError("HISTORY_BACKEND must be supabase or postgres")
    return backend


def connection_settings():
    required = ("HISTORY_DB_HOST", "HISTORY_DB_NAME", "HISTORY_DB_USER", "HISTORY_DB_PASSWORD")
    if any(not os.getenv(key) for key in required):
        raise RuntimeError("PostgreSQL history configuration is incomplete")
    try:
        port = int(os.getenv("HISTORY_DB_PORT", "5432"))
        size = int(os.getenv("HISTORY_DB_POOL_SIZE", "2"))
        if not 1 <= port <= 65535 or not 1 <= size <= 10:
            raise ValueError
    except ValueError:
        raise RuntimeError("Invalid PostgreSQL history port or pool size") from None
    ca = os.getenv("HISTORY_DB_SSLROOTCERT", str(Path(__file__).parent / "certs" / "rds-ca.pem"))
    if not Path(ca).is_file():
        raise RuntimeError("PostgreSQL history CA certificate is unavailable")
    return {
        "host": os.environ["HISTORY_DB_HOST"], "port": port,
        "dbname": os.environ["HISTORY_DB_NAME"], "user": os.environ["HISTORY_DB_USER"],
        "password": os.environ["HISTORY_DB_PASSWORD"], "sslmode": "verify-full", "sslrootcert": ca,
        "connect_timeout": 5, "autocommit": True, "row_factory": dict_row,
        "options": "-c statement_timeout=10000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=15000",
    }, size


async def check_application_role(conn):
    role = await (await conn.execute("""SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
        FROM pg_roles WHERE rolname=current_user""")).fetchone()
    if role is None or any(role.values()):
        raise RuntimeError("History requires a restricted application database role")
    tables = await (await conn.execute("""SELECT tablename, rowsecurity, tableowner=current_user AS owned
        FROM pg_tables WHERE schemaname='app' AND tablename IN ('quiz_history','user_identities')""")).fetchall()
    if len(tables) != 2 or any(row["owned"] or not row["rowsecurity"] for row in tables):
        raise RuntimeError("History requires separate table ownership and enabled RLS")
    privileges = await (await conn.execute("""SELECT
        has_schema_privilege(current_user,'app','CREATE') AS schema_create,
        has_table_privilege(current_user,'app.quiz_history','TRUNCATE') AS truncate_history,
        has_table_privilege(current_user,'app.quiz_history','UPDATE') AS update_history,
        has_table_privilege(current_user,'app.user_identities','INSERT,UPDATE,DELETE,TRUNCATE') AS write_identities,
        has_table_privilege(current_user,'app.users','INSERT,UPDATE,DELETE,TRUNCATE') AS write_users""")).fetchone()
    if any(privileges.values()):
        raise RuntimeError("History database role has excessive privileges")


class _SafePoolLog(logging.Filter):
    """Pool connection exceptions can contain connection details: omit their text."""
    def filter(self, record):
        record.msg = "PostgreSQL history pool event"
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        return True


logging.getLogger("psycopg.pool").addFilter(_SafePoolLog())


async def start_history_database(app):
    app.state.history_backend = history_backend()
    app.state.history_pool = None
    if app.state.history_backend != "postgres":
        return
    kwargs, size = connection_settings()
    pool = AsyncConnectionPool(kwargs=kwargs, min_size=1, max_size=size, max_waiting=20,
                               timeout=5, open=False, name="quizforge-history",
                               configure=check_application_role,
                               check=AsyncConnectionPool.check_connection)
    try:
        await pool.open(wait=True, timeout=15)
    except Exception:
        await pool.close()
        raise RuntimeError("PostgreSQL history pool could not start") from None
    app.state.history_pool = pool


async def close_history_database(app):
    pool = getattr(app.state, "history_pool", None)
    if pool is not None:
        app.state.history_pool = None
        await pool.close()
