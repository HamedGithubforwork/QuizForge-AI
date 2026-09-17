import asyncio
import logging
from unittest.mock import Mock

from fastapi import FastAPI
import pytest

import history_database


def test_supabase_default_never_opens_postgres(monkeypatch):
    monkeypatch.delenv("HISTORY_BACKEND", raising=False)
    pool = Mock(side_effect=AssertionError("Unexpected database connection"))
    monkeypatch.setattr(history_database, "AsyncConnectionPool", pool)
    app = FastAPI()
    asyncio.run(history_database.start_history_database(app))
    assert app.state.history_backend == "supabase" and app.state.history_pool is None
    pool.assert_not_called()


def test_unknown_backend_fails_closed(monkeypatch):
    monkeypatch.setenv("HISTORY_BACKEND", "postgress")
    with pytest.raises(RuntimeError, match="HISTORY_BACKEND"):
        history_database.history_backend()


def settings(monkeypatch):
    for name, value in {"HOST": "private.example", "NAME": "quizforge", "USER": "quizforge_app",
                        "PASSWORD": "never-log-this-value"}.items():
        monkeypatch.setenv("HISTORY_DB_" + name, value)


def test_tls_cannot_be_downgraded_by_connection_environment(monkeypatch):
    settings(monkeypatch)
    monkeypatch.setenv("PGSSLMODE", "disable")
    monkeypatch.setenv("HISTORY_DB_SSLMODE", "disable")
    options, size = history_database.connection_settings()
    assert options["sslmode"] == "verify-full" and size == 2
    assert options["connect_timeout"] == 5 and "statement_timeout=10000" in options["options"]


@pytest.mark.parametrize("name,value", [("HISTORY_DB_POOL_SIZE", "0"), ("HISTORY_DB_POOL_SIZE", "11"),
                                        ("HISTORY_DB_PORT", "not-a-port"), ("HISTORY_DB_PORT", "65536"),
                                        ("HISTORY_DB_SSLROOTCERT", "/missing/ca.pem")])
def test_invalid_settings_fail_without_exposing_credentials(monkeypatch, name, value):
    settings(monkeypatch)
    monkeypatch.setenv(name, value)
    with pytest.raises(RuntimeError) as error:
        history_database.connection_settings()
    assert "never-log-this-value" not in str(error.value)


def test_pool_errors_do_not_log_raw_connection_details(caplog):
    with caplog.at_level(logging.WARNING, logger="psycopg.pool"):
        logging.getLogger("psycopg.pool").warning("Connection failed: %s", "private-password-or-query")
    assert "private-password-or-query" not in caplog.text
    assert "PostgreSQL history pool event" in caplog.text
