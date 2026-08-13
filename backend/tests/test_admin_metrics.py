import asyncio

import pytest
from fastapi import HTTPException

import main_redis
from admin_metrics import get_metric_snapshot
from observability import METRIC_PREFIX


class FakeReadPipeline:
    def __init__(self, values):
        self.values = values
        self.keys = []

    def get(self, key):
        self.keys.append(key)
        return self

    async def execute(self):
        return [
            self.values.get(key)
            for key in self.keys
        ]


class FakeReadRedis:
    def __init__(self, values):
        self.values = values

    def pipeline(self, transaction=False):
        assert transaction is False
        return FakeReadPipeline(self.values)


def metric_values(**values):
    return {
        f"{METRIC_PREFIX}{name}": value
        for name, value in values.items()
    }


def test_metric_snapshot_calculates_rates_and_averages():
    client = FakeReadRedis(
        metric_values(
            http_requests_total="10",
            http_duration_ms_total="2500",
            http_5xx_total="2",
            quiz_requests_total="4",
            quiz_duration_ms_total="8000",
            quiz_cache_hits_total="3",
            quiz_cache_misses_total="1",
            quiz_generation_errors_total="1",
        )
    )

    snapshot = asyncio.run(
        get_metric_snapshot(client)
    )

    assert snapshot["metrics_backend"] == "redis"
    assert snapshot["http_requests_total"] == 10
    assert snapshot["http_5xx_total"] == 2
    assert snapshot["average_http_latency_ms"] == 250.0
    assert snapshot["quiz_requests_total"] == 4
    assert snapshot["average_quiz_latency_ms"] == 2000.0
    assert snapshot["cache_hits_total"] == 3
    assert snapshot["cache_misses_total"] == 1
    assert snapshot["cache_hit_rate_percent"] == 75.0
    assert snapshot["quiz_generation_errors_total"] == 1


def test_metric_snapshot_handles_zero_totals():
    snapshot = asyncio.run(
        get_metric_snapshot(None)
    )

    assert snapshot["metrics_backend"] == "memory"
    assert snapshot["average_http_latency_ms"] >= 0
    assert snapshot["average_quiz_latency_ms"] >= 0
    assert snapshot["cache_hit_rate_percent"] >= 0


def test_admin_access_requires_allowlisted_user(monkeypatch):
    monkeypatch.setenv(
        "ADMIN_USER_IDS",
        "admin-user,second-admin",
    )

    user = main_redis.AuthenticatedUser(
        id="regular-user",
        email="user@example.com",
    )

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            main_redis.require_admin(user)
        )

    assert error.value.status_code == 403


def test_admin_access_accepts_allowlisted_user(monkeypatch):
    monkeypatch.setenv(
        "ADMIN_USER_IDS",
        "admin-user,second-admin",
    )

    user = main_redis.AuthenticatedUser(
        id="admin-user",
        email="admin@example.com",
    )

    result = asyncio.run(
        main_redis.require_admin(user)
    )

    assert result.id == "admin-user"


def test_admin_access_is_locked_when_allowlist_is_empty(monkeypatch):
    monkeypatch.delenv(
        "ADMIN_USER_IDS",
        raising=False,
    )

    user = main_redis.AuthenticatedUser(
        id="admin-user",
    )

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            main_redis.require_admin(user)
        )

    assert error.value.status_code == 403


def test_admin_metrics_route_is_registered():
    paths = {
        getattr(route, "path", None)
        for route in main_redis.app.router.routes
    }

    assert "/api/admin/metrics" in paths
