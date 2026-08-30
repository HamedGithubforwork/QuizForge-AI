import asyncio
import os

from redis.asyncio import Redis

from admin_metrics import get_metric_snapshot
from observability import (
    TIMING_PREFIX,
    record_timing_sample,
)


def test_real_redis_timing_samples_feed_admin_percentiles():
    redis_url = os.environ.get(
        "TEST_REDIS_URL",
        "redis://127.0.0.1:6379/0",
    )

    async def scenario():
        client = Redis.from_url(
            redis_url,
            encoding="utf-8",
            decode_responses=True,
        )

        try:
            # TEST_REDIS_URL points at the disposable Redis service used by
            # this test/CI job. Never point this test at a valued Redis DB.
            await client.flushdb()

            for duration_ms in (
                10,
                20,
                30,
                40,
            ):
                await record_timing_sample(
                    client,
                    "auth_latency_ms",
                    duration_ms,
                )

            stored_samples = await client.lrange(
                f"{TIMING_PREFIX}auth_latency_ms",
                0,
                -1,
            )
            snapshot = await get_metric_snapshot(
                client
            )

            assert len(stored_samples) == 4
            assert snapshot["metrics_backend"] == "redis"
            assert snapshot[
                "latency_percentiles_ms"
            ]["auth"] == {
                "sample_count": 4,
                "p50": 20.0,
                "p95": 40.0,
            }
        finally:
            await client.flushdb()
            await client.aclose()

    asyncio.run(scenario())
