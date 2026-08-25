import asyncio
import logging

from redis.exceptions import RedisError

from observability import (
    METRIC_PREFIX,
    METRICS_TIMEOUT_SECONDS,
    get_memory_metric,
    log_event,
)


METRIC_NAMES = (
    "http_requests_total",
    "http_duration_ms_total",
    "http_5xx_total",
    "quiz_requests_total",
    "quiz_duration_ms_total",
    "quiz_cache_hits_total",
    "quiz_cache_misses_total",
    "document_cache_hits_total",
    "document_cache_misses_total",
    "quiz_generation_errors_total",
)


def build_metric_snapshot(values: dict[str, int], backend: str):
    http_requests = values["http_requests_total"]
    quiz_requests = values["quiz_requests_total"]
    cache_hits = values["quiz_cache_hits_total"]
    cache_misses = values["quiz_cache_misses_total"]
    cache_lookups = cache_hits + cache_misses
    document_cache_hits = values[
        "document_cache_hits_total"
    ]
    document_cache_misses = values[
        "document_cache_misses_total"
    ]
    document_cache_lookups = (
        document_cache_hits
        + document_cache_misses
    )

    average_http_latency = (
        values["http_duration_ms_total"] / http_requests
        if http_requests
        else 0.0
    )
    average_quiz_latency = (
        values["quiz_duration_ms_total"] / quiz_requests
        if quiz_requests
        else 0.0
    )
    cache_hit_rate = (
        cache_hits / cache_lookups * 100
        if cache_lookups
        else 0.0
    )
    document_cache_hit_rate = (
        document_cache_hits
        / document_cache_lookups
        * 100
        if document_cache_lookups
        else 0.0
    )

    return {
        "metrics_backend": backend,
        "http_requests_total": http_requests,
        "http_5xx_total": values["http_5xx_total"],
        "average_http_latency_ms": round(average_http_latency, 2),
        "quiz_requests_total": quiz_requests,
        "quiz_generation_errors_total": values["quiz_generation_errors_total"],
        "average_quiz_latency_ms": round(average_quiz_latency, 2),
        "cache_hits_total": cache_hits,
        "cache_misses_total": cache_misses,
        "cache_hit_rate_percent": round(cache_hit_rate, 2),
        "document_cache_hits_total": document_cache_hits,
        "document_cache_misses_total": document_cache_misses,
        "document_cache_hit_rate_percent": round(
            document_cache_hit_rate,
            2,
        ),
    }


async def get_metric_snapshot(client=None):
    if client is not None:
        try:
            pipeline = client.pipeline(transaction=False)
            for metric_name in METRIC_NAMES:
                pipeline.get(f"{METRIC_PREFIX}{metric_name}")

            raw_values = await asyncio.wait_for(
                pipeline.execute(),
                timeout=METRICS_TIMEOUT_SECONDS,
            )
            values = {
                metric_name: int(raw_value or 0)
                for metric_name, raw_value in zip(METRIC_NAMES, raw_values)
            }
            return build_metric_snapshot(values, "redis")
        except (
            RedisError,
            AttributeError,
            asyncio.TimeoutError,
            TypeError,
            ValueError,
        ) as error:
            log_event(
                "metrics_read_error",
                level=logging.WARNING,
                error_type=type(error).__name__,
            )

    values = {
        metric_name: get_memory_metric(metric_name)
        for metric_name in METRIC_NAMES
    }
    return build_metric_snapshot(values, "memory")
