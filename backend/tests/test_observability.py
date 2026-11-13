import asyncio
from types import SimpleNamespace

from redis.exceptions import RedisError

from observability import (
    METRIC_PREFIX,
    TIMING_PREFIX,
    log_event,
    observe_http_request,
    record_document_cache_metric,
    record_quiz_metrics,
    record_timing_sample,
    record_timing_samples,
    _memory_timing_samples,
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

    def lpush(self, key, *values):
        self.client.lpush_command_count += 1
        self.client.lpush_calls.append((key, values))
        self.client.timing_calls.extend(
            ("lpush", key, value) for value in values
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
        self.client.execute_count += 1
        if self.client.fail_execute:
            raise RedisError("Redis unavailable")
        return [1] * self.operation_count


class FakeRedis:
    def __init__(self):
        self.calls = []
        self.timing_calls = []
        self.lpush_calls = []
        self.pipeline_count = 0
        self.execute_count = 0
        self.lpush_command_count = 0
        self.fail_execute = False

    def pipeline(
        self,
        transaction=False,
    ):
        assert transaction is False
        self.pipeline_count += 1
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


def test_timing_sample_batch_uses_one_pipeline_and_preserves_lpush_order():
    client = FakeRedis()
    samples = [12.345, -1.0]

    asyncio.run(
        record_timing_samples(
            client,
            "quiz_validation_latency_ms",
            samples,
        )
    )

    key = f"{TIMING_PREFIX}quiz_validation_latency_ms"
    assert client.pipeline_count == 1
    assert client.execute_count == 1
    assert client.lpush_command_count == 1
    assert client.lpush_calls == [(key, (12.35, 0.0))]
    assert client.timing_calls == [
        ("lpush", key, 12.35),
        ("lpush", key, 0.0),
        ("ltrim", key, 0, 199),
    ]
    # Redis LPUSH inserts each argument at the head, so the final list is newest first.
    assert list(reversed(client.lpush_calls[0][1])) == [0.0, 12.35]


def test_timing_sample_batch_sends_only_the_newest_bounded_redis_samples():
    client = FakeRedis()
    samples = list(range(205))

    asyncio.run(
        record_timing_samples(
            client,
            "quiz_validation_latency_ms",
            samples,
        )
    )

    key = f"{TIMING_PREFIX}quiz_validation_latency_ms"
    expected = tuple(float(sample) for sample in samples[-200:])
    assert client.pipeline_count == 1
    assert client.execute_count == 1
    assert client.lpush_calls == [(key, expected)]
    assert list(reversed(client.lpush_calls[0][1])) == list(range(204, 4, -1))


def test_timing_sample_batch_preserves_memory_fallback_and_allowlist():
    timing_name = "quiz_validation_latency_ms"
    memory_samples = _memory_timing_samples[timing_name]
    memory_samples.clear()
    try:
        asyncio.run(record_timing_samples(None, timing_name, [3.456, -2]))
        assert list(memory_samples) == [3.46, 0.0]

        client = FakeRedis()
        client.fail_execute = True
        asyncio.run(record_timing_samples(client, timing_name, [4.444, 5.555]))
        assert client.execute_count == 1
        assert list(memory_samples) == [3.46, 0.0, 4.44, 5.55]

        asyncio.run(record_timing_samples(client, "unknown_timing_ms", [99]))
        assert client.pipeline_count == 1
        assert list(memory_samples) == [3.46, 0.0, 4.44, 5.55]
    finally:
        memory_samples.clear()


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

