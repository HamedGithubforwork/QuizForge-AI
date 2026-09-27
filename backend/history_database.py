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


def connection_settings(prefix="HISTORY_DB"):
    required = tuple(prefix + "_" + key for key in ("HOST", "NAME", "USER", "PASSWORD"))
    if any(not os.getenv(key) for key in required):
        raise RuntimeError("PostgreSQL history configuration is incomplete")
    try:
        port = int(os.getenv(prefix + "_PORT", "5432"))
        size = int(os.getenv(prefix + "_POOL_SIZE", "2"))
        if not 1 <= port <= 65535 or not 1 <= size <= 10:
            raise ValueError
    except ValueError:
        raise RuntimeError("Invalid PostgreSQL history port or pool size") from None
    ca = os.getenv(prefix + "_SSLROOTCERT", str(Path(__file__).parent / "certs" / "rds-ca.pem"))
    if not Path(ca).is_file():
        raise RuntimeError("PostgreSQL history CA certificate is unavailable")
    return {
        "host": os.environ[prefix + "_HOST"], "port": port,
        "dbname": os.environ[prefix + "_NAME"], "user": os.environ[prefix + "_USER"],
        "password": os.environ[prefix + "_PASSWORD"], "sslmode": "verify-full", "sslrootcert": ca,
        "connect_timeout": 5, "autocommit": True, "row_factory": dict_row,
        "options": "-c statement_timeout=10000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=15000",
    }, size


async def check_application_role(conn):
    role = await (await conn.execute("""SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
        FROM pg_roles WHERE rolname=current_user""")).fetchone()
    if role is None or any(role.values()):
        raise RuntimeError("History requires a restricted application database role")
    tables = await (await conn.execute("""SELECT tablename, rowsecurity, tableowner=current_user AS owned
        FROM pg_tables WHERE schemaname='app'
        AND tablename IN ('quiz_history','user_identities','decks','cards','card_review_logs')""")).fetchall()
    if len(tables) != 5 or any(row["owned"] or not row["rowsecurity"] for row in tables):
        raise RuntimeError("Application data requires separate table ownership and enabled RLS")
    privileges = await (await conn.execute("""SELECT
        has_schema_privilege(current_user,'app','CREATE') AS schema_create,
        has_table_privilege(current_user,'app.quiz_history','TRUNCATE') AS truncate_history,
        has_table_privilege(current_user,'app.quiz_history','UPDATE') AS update_history,
        has_table_privilege(current_user,'app.decks','TRUNCATE') AS truncate_decks,
        has_table_privilege(current_user,'app.decks','UPDATE') AS full_update_decks,
        has_column_privilege(current_user,'app.decks','user_id','UPDATE') AS update_deck_owner,
        has_table_privilege(current_user,'app.cards','TRUNCATE') AS truncate_cards,
        has_table_privilege(current_user,'app.cards','UPDATE') AS full_update_cards,
        has_column_privilege(current_user,'app.cards','user_id','UPDATE') AS update_card_owner,
        has_column_privilege(current_user,'app.cards','deck_id','UPDATE') AS move_card_owner,
        has_table_privilege(current_user,'app.card_review_logs','UPDATE,DELETE,TRUNCATE') AS mutate_review_logs,
        has_any_column_privilege(current_user,'app.card_review_logs','UPDATE') AS update_review_log_columns,
        has_table_privilege(current_user,'app.user_identities','INSERT,UPDATE,DELETE,TRUNCATE') AS write_identities,
        has_table_privilege(current_user,'app.users','INSERT,UPDATE,DELETE,TRUNCATE') AS write_users""")).fetchone()
    if any(privileges.values()):
        raise RuntimeError("Application database role has excessive privileges")

    required = await (await conn.execute("""SELECT
        has_table_privilege(current_user,'app.card_review_logs','SELECT,INSERT') AS review_log_access,
        has_column_privilege(current_user,'app.cards','fsrs_state','UPDATE') AS update_fsrs_state,
        has_column_privilege(current_user,'app.cards','fsrs_step','UPDATE') AS update_fsrs_step,
        has_column_privilege(current_user,'app.cards','stability','UPDATE') AS update_stability,
        has_column_privilege(current_user,'app.cards','difficulty','UPDATE') AS update_difficulty,
        has_column_privilege(current_user,'app.cards','due_at','UPDATE') AS update_due_at,
        has_column_privilege(current_user,'app.cards','last_reviewed_at','UPDATE') AS update_last_reviewed_at,
        has_column_privilege(current_user,'app.cards','review_count','UPDATE') AS update_review_count,
        has_column_privilege(current_user,'app.cards','lapse_count','UPDATE') AS update_lapse_count""")).fetchone()
    if not all(required.values()):
        raise RuntimeError("Application database role is missing review privileges")


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
