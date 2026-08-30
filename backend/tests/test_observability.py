import asyncio
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


def test_log_event_returns_structured_payload():
    payload = log_event(
        "test_event",
        example_value=3,
    )

    assert payload["event"] == "test_event"
    assert payload["example_value"] == 3
    assert payload["timestamp"]


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


def test_http_observability_adds_request_id_and_metrics():
    client = FakeRedis()
    request = SimpleNamespace(
        method="GET",
        url=SimpleNamespace(
            path="/api/health",
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
