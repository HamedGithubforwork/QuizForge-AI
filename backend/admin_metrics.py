import asyncio
import logging
import math

from redis.exceptions import RedisError

from observability import (
    METRIC_PREFIX,
    METRICS_TIMEOUT_SECONDS,
    TIMING_PREFIX,
    TIMING_SAMPLE_LIMIT,
    TIMING_SAMPLE_NAMES,
    get_memory_metric,
    get_memory_timing_samples,
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

TIMING_DISPLAY_NAMES = {
    "http_latency_ms": "http",
    "quiz_latency_ms": "quiz",
    "auth_latency_ms": "auth",
    "document_cache_lookup_latency_ms": (
        "document_cache_lookup"
    ),
    "document_cache_write_latency_ms": (
        "document_cache_write"
    ),
    "pdf_extraction_latency_ms": "pdf_extraction",
    "openai_generation_latency_ms": "openai_generation",
    "quiz_validation_latency_ms": "quiz_validation",
    "quiz_cache_lookup_latency_ms": "quiz_cache_lookup",
    "quiz_cache_write_latency_ms": "quiz_cache_write",
}


def _nearest_rank_percentile(
    samples: list[float],
    percentile: float,
):
    if not samples:
        return 0.0

    ordered = sorted(samples)
    rank = max(
        1,
        math.ceil(
            percentile * len(ordered)
        ),
    )
    return round(
        ordered[rank - 1],
        2,
    )


def build_latency_percentiles(
    timing_samples: dict[str, list[float]],
):
    result = {}

    for timing_name in TIMING_SAMPLE_NAMES:
        samples = [
            max(0.0, float(sample))
            for sample in timing_samples.get(
                timing_name,
                [],
            )
        ]
        result[
            TIMING_DISPLAY_NAMES[timing_name]
        ] = {
            "sample_count": len(samples),
            "p50": _nearest_rank_percentile(
                samples,
                0.50,
            ),
            "p95": _nearest_rank_percentile(
                samples,
                0.95,
            ),
        }

    return result


def build_metric_snapshot(
    values: dict[str, int],
    backend: str,
    timing_samples: dict[str, list[float]] | None = None,
):
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
        "latency_percentiles_ms": build_latency_percentiles(
            timing_samples or {}
        ),
    }


def _parse_timing_samples(raw_samples):
    samples = []

    for raw_sample in raw_samples or []:
        try:
            samples.append(
                max(0.0, float(raw_sample))
            )
        except (TypeError, ValueError):
            continue

    return samples


async def get_metric_snapshot(client=None):
    if client is not None:
        try:
            pipeline = client.pipeline(transaction=False)
            for metric_name in METRIC_NAMES:
                pipeline.get(f"{METRIC_PREFIX}{metric_name}")
            for timing_name in TIMING_SAMPLE_NAMES:
                pipeline.lrange(
                    f"{TIMING_PREFIX}{timing_name}",
                    0,
                    TIMING_SAMPLE_LIMIT - 1,
                )

            raw_values = await asyncio.wait_for(
                pipeline.execute(),
                timeout=METRICS_TIMEOUT_SECONDS,
            )
            scalar_count = len(METRIC_NAMES)
            raw_metrics = raw_values[:scalar_count]
            raw_timings = raw_values[scalar_count:]
            values = {
                metric_name: int(raw_value or 0)
                for metric_name, raw_value in zip(
                    METRIC_NAMES,
                    raw_metrics,
                )
            }
            timing_samples = {
                timing_name: _parse_timing_samples(
                    raw_samples
                )
                for timing_name, raw_samples in zip(
                    TIMING_SAMPLE_NAMES,
                    raw_timings,
                )
            }
            return build_metric_snapshot(
                values,
                "redis",
                timing_samples,
            )
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
    timing_samples = {
        timing_name: get_memory_timing_samples(
            timing_name
        )
        for timing_name in TIMING_SAMPLE_NAMES
    }
    return build_metric_snapshot(
        values,
        "memory",
        timing_samples,
    )
