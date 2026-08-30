import asyncio

import app_shared


def test_startup_performance_snapshot_logs_metric_snapshot(monkeypatch):
    snapshot = {
        "metrics_backend": "redis",
        "http_requests_total": 12,
        "http_5xx_total": 0,
        "average_http_latency_ms": 31.25,
        "quiz_requests_total": 3,
        "quiz_generation_errors_total": 0,
        "average_quiz_latency_ms": 4020.5,
        "cache_hits_total": 1,
        "cache_misses_total": 2,
        "cache_hit_rate_percent": 33.33,
        "document_cache_hits_total": 2,
        "document_cache_misses_total": 1,
        "document_cache_hit_rate_percent": 66.67,
        "latency_percentiles_ms": {
            "auth": {
                "sample_count": 3,
                "p50": 120.0,
                "p95": 180.0,
            },
            "openai_generation": {
                "sample_count": 2,
                "p50": 9800.0,
                "p95": 12100.0,
            },
        },
    }
    events = []

    async def fake_snapshot(_client):
        return snapshot

    monkeypatch.setattr(
        app_shared,
        "_get_performance_snapshot",
        fake_snapshot,
    )
    monkeypatch.setattr(
        app_shared,
        "log_event",
        lambda event, **fields: events.append(
            (event, fields)
        ),
    )

    asyncio.run(
        app_shared.log_startup_performance_snapshot(
            object()
        )
    )

    assert events == [
        (
            "performance_snapshot",
            {
                "snapshot": snapshot,
            },
        )
    ]


def test_startup_performance_snapshot_failure_does_not_break_startup(monkeypatch):
    events = []

    async def failing_snapshot(_client):
        raise RuntimeError("boom")

    monkeypatch.setattr(
        app_shared,
        "_get_performance_snapshot",
        failing_snapshot,
    )
    monkeypatch.setattr(
        app_shared,
        "log_event",
        lambda event, **fields: events.append(
            (event, fields)
        ),
    )

    asyncio.run(
        app_shared.log_startup_performance_snapshot(
            object()
        )
    )

    assert events == [
        (
            "performance_snapshot_error",
            {
                "error_type": "RuntimeError",
            },
        )
    ]


def test_app_lifespan_records_snapshot_without_blocking_shutdown(monkeypatch):
    events = []

    async def fake_start():
        events.append("start")

    async def fake_snapshot(_client):
        events.append("snapshot")

    async def fake_close():
        events.append("close")

    monkeypatch.setattr(
        app_shared,
        "start_outbound_clients",
        fake_start,
    )
    monkeypatch.setattr(
        app_shared,
        "log_startup_performance_snapshot",
        fake_snapshot,
    )
    monkeypatch.setattr(
        app_shared,
        "close_outbound_clients",
        fake_close,
    )

    async def run_lifespan():
        async with app_shared.app_lifespan(None):
            events.append("yield")

    asyncio.run(run_lifespan())

    assert events == [
        "start",
        "snapshot",
        "yield",
        "close",
    ]
