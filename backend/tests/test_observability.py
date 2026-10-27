import asyncio
import json
import observability
from types import SimpleNamespace

from observability import (
    METRIC_PREFIX,
    TIMING_PREFIX,
    log_event,
    observe_http_request,
    record_document_cache_metric,
    record_quiz_metrics,
    record_timing_sample,
)


class FakePipeline:
    def __init__(self, client):
        self.client = client
        self.operation_count = 0

    def incrby(self, key, amount):
        self.client.calls.append(
            (key, amount)
        )
        self.operation_count += 1
        return self

    def lpush(self, key, value):
        self.client.timing_calls.append(
            ("lpush", key, value)
        )
        self.operation_count += 1
        return self

    def ltrim(self, key, start, end):
        self.client.timing_calls.append(
            ("ltrim", key, start, end)
        )
        self.operation_count += 1
        return self

    async def execute(self):
        return [1] * self.operation_count


class FakeRedis:
    def __init__(self):
        self.calls = []
        self.timing_calls = []

    def pipeline(
        self,
        transaction=False,
    ):
        assert transaction is False
        return FakePipeline(self)


def test_log_event_drops_unapproved_fields_and_unknown_events(monkeypatch):
    emitted = []
    monkeypatch.setattr(observability.logger, "log", lambda _level, message: emitted.append(message))
    payload = log_event("document_cache_lookup", cache_result="hit", page_count=3,
        password="SYNTHETIC_PASSWORD", access_token="SYNTHETIC_ACCESS_TOKEN",
        refresh_token="SYNTHETIC_REFRESH_TOKEN", api_key="SYNTHETIC_API_KEY",
        private_pdf="SYNTHETIC_PRIVATE_PDF", card_number="4111111111111111",
        error="SYNTHETIC_EXCEPTION_TEXT", url="https://example.test/?token=SYNTHETIC_URL_TOKEN")
    assert payload["event"] == "document_cache_lookup"
    assert payload["cache_result"] == "hit" and payload["page_count"] == 3
    assert payload["timestamp"]
    assert set(payload) == {"timestamp", "event", "cache_result", "page_count"}
    for value in ("SYNTHETIC_PASSWORD", "SYNTHETIC_ACCESS_TOKEN", "SYNTHETIC_REFRESH_TOKEN",
                  "SYNTHETIC_API_KEY", "SYNTHETIC_PRIVATE_PDF", "4111111111111111",
                  "SYNTHETIC_EXCEPTION_TEXT", "SYNTHETIC_URL_TOKEN"):
        assert value not in emitted[0]
    unknown = log_event("unregistered_event", private_data="SYNTHETIC_PRIVATE_DATA")
    assert unknown["event"] == "unclassified"
    assert set(unknown) == {"timestamp", "event"}
    assert "SYNTHETIC_PRIVATE_DATA" not in emitted[1]
    failure = log_event("http_request_failed", request_id="a" * 32, method="POST",
        duration_ms=12, error_type="SYNTHETIC_ACCESS_TOKEN",
        exception="SYNTHETIC_EXCEPTION_TEXT", url="https://example.test/?key=SYNTHETIC_URL_TOKEN")
    assert "error_type" not in failure
    assert all(value not in emitted[2] for value in
               ("SYNTHETIC_ACCESS_TOKEN", "SYNTHETIC_EXCEPTION_TEXT", "SYNTHETIC_URL_TOKEN"))


def test_document_cache_metrics_track_hit_and_miss():
    client = FakeRedis()

    asyncio.run(
        record_document_cache_metric(
            client,
            "hit",
        )
    )
    asyncio.run(
        record_document_cache_metric(
            client,
            "miss",
        )
    )

    assert client.calls == [
        (
            f"{METRIC_PREFIX}document_cache_hits_total",
            1,
        ),
        (
            f"{METRIC_PREFIX}document_cache_misses_total",
            1,
        ),
    ]


def test_timing_metric_keeps_a_bounded_redis_sample_list():
    client = FakeRedis()

    asyncio.run(
        record_timing_sample(
            client,
            "auth_latency_ms",
            12.345,
        )
    )

    key = f"{TIMING_PREFIX}auth_latency_ms"
    assert client.timing_calls == [
        ("lpush", key, 12.35),
        ("ltrim", key, 0, 199),
    ]


def test_quiz_metrics_track_cache_hit_and_latency():
    client = FakeRedis()

    asyncio.run(
        record_quiz_metrics(
            client,
            cache_result="hit",
            duration_ms=123.6,
        )
    )

    assert client.calls == [
        (
            f"{METRIC_PREFIX}quiz_requests_total",
            1,
        ),
        (
            f"{METRIC_PREFIX}quiz_duration_ms_total",
            124,
        ),
        (
            f"{METRIC_PREFIX}quiz_cache_hits_total",
            1,
        ),
    ]
    assert (
        "lpush",
        f"{TIMING_PREFIX}quiz_latency_ms",
        123.6,
    ) in client.timing_calls


def test_quiz_metrics_track_failed_cache_miss():
    client = FakeRedis()

    asyncio.run(
        record_quiz_metrics(
            client,
            cache_result="miss",
            duration_ms=50,
            failed=True,
        )
    )

    assert (
        f"{METRIC_PREFIX}quiz_cache_misses_total",
        1,
    ) in client.calls
    assert (
        f"{METRIC_PREFIX}quiz_generation_errors_total",
        1,
    ) in client.calls


def test_http_observability_adds_request_id_and_metrics(monkeypatch):
    emitted = []
    monkeypatch.setattr(observability.logger, "log", lambda _level, message: emitted.append(message))
    client = FakeRedis()
    request = SimpleNamespace(
        method="GET",
        url=SimpleNamespace(
            path="/api/private/SYNTHETIC_EMAIL",
        ),
    )

    async def call_next(_request):
        return SimpleNamespace(
            status_code=200,
            headers={},
        )

    response = asyncio.run(
        observe_http_request(
            request,
            call_next,
            client,
        )
    )

    assert response.headers["X-Request-ID"]
    assert "SYNTHETIC_EMAIL" not in emitted[-1]
    assert '"path"' not in emitted[-1]
    assert (
        f"{METRIC_PREFIX}http_requests_total",
        1,
    ) in client.calls
    assert any(
        call[0] == "lpush"
        and call[1]
        == f"{TIMING_PREFIX}http_latency_ms"
        for call in client.timing_calls
    )



def test_http_observability_returns_safe_response_for_unhandled_errors(monkeypatch):
    emitted = []
    monkeypatch.setattr(
        observability.logger,
        "log",
        lambda _level, message: emitted.append(message),
    )
    request = SimpleNamespace(
        method="POST",
        url=SimpleNamespace(path="/api/private/SYNTHETIC_EMAIL"),
    )

    async def call_next(_request):
        raise RuntimeError(
            "SYNTHETIC_PASSWORD SYNTHETIC_ACCESS_TOKEN "
            "SYNTHETIC_REFRESH_TOKEN SYNTHETIC_API_KEY "
            "SYNTHETIC_PRIVATE_PDF 4111111111111111 "
            "https://example.test/?token=SYNTHETIC_URL_TOKEN"
        )

    response = asyncio.run(observe_http_request(request, call_next))
    assert response.status_code == 500
    assert response.headers["X-Request-ID"]
    assert json.loads(response.body) == {"detail": "Internal server error."}
    for value in (
        "SYNTHETIC_PASSWORD",
        "SYNTHETIC_ACCESS_TOKEN",
        "SYNTHETIC_REFRESH_TOKEN",
        "SYNTHETIC_API_KEY",
        "SYNTHETIC_PRIVATE_PDF",
        "4111111111111111",
        "SYNTHETIC_URL_TOKEN",
    ):
        assert value not in emitted[-1]
