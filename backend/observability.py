import asyncio
import json
import logging
import os
import re
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any

from redis.exceptions import RedisError
from starlette.responses import JSONResponse


METRIC_PREFIX = "quizforge:metrics:"
TIMING_PREFIX = f"{METRIC_PREFIX}timing:"
METRICS_TIMEOUT_SECONDS = 0.25
TIMING_SAMPLE_LIMIT = 200
TIMING_SAMPLE_NAMES = (
    "http_latency_ms",
    "quiz_latency_ms",
    "auth_latency_ms",
    "document_cache_lookup_latency_ms",
    "document_cache_write_latency_ms",
    "pdf_extraction_latency_ms",
    "openai_generation_latency_ms",
    "quiz_validation_latency_ms",
    "quiz_cache_lookup_latency_ms",
    "quiz_cache_write_latency_ms",
)

logger = logging.getLogger("quizforge.observability")

if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)

log_level_name = os.getenv("LOG_LEVEL", "INFO").strip().upper()
logger.setLevel(getattr(logging, log_level_name, logging.INFO))
logger.propagate = False

_memory_metrics: dict[str, int] = defaultdict(int)
_memory_timing_samples: dict[str, deque[float]] = defaultdict(
    lambda: deque(maxlen=TIMING_SAMPLE_LIMIT)
)


# Structured logs are a data boundary. Unknown events and fields are omitted.
_LOG_EVENT_FIELDS = {
    "metrics_backend_error": {"metrics", "error_type"},
    "metrics_read_error": {"error_type"},
    "timing_metrics_backend_error": {"timing_name", "error_type"},
    "http_request_failed": {"request_id", "method", "duration_ms", "error_type"},
    "http_request_completed": {"request_id", "method", "status_code", "duration_ms"},
    "performance_snapshot_error": {"error_type"},
    "performance_snapshot": {"snapshot"},
    "document_cache_lookup": {"cache_result", "page_count", "stored", "fallback_stored"},
    "processed_document_lookup": {"cache_result", "page_count"},
    "quiz_generation_completed": {"cache_result", "duration_ms", "question_count", "singleflight_waited"},
    "quiz_context_selected": {"original_page_count", "selected_page_count", "total_chunk_count", "selected_chunk_count", "total_character_count", "selected_character_count", "truncated", "focus_page_count"},
    "quiz_context_grounding_rejected": {"invalid_source_page_count"},
    "quiz_generation_failed": {"cache_result", "duration_ms", "question_count", "status_code", "error_type"},
    "quiz_generation_rejected": {"cache_result", "duration_ms", "question_count", "status_code", "error_type"},
    "pdf_queue_unavailable": {"error_type"},
    "pdf_ocr_error": {"error_type"},
    "pdf_ocr_completed": {"attempted_page_count", "improved_page_count", "page_count", "remaining_scanned_likely", "duration_ms"},
    "openai_quiz_generation_error": {"error_type"},
    "quiz_validation_failed": {"generation_attempt", "issue_count"},
    "document_cache_store_skipped": {"reason"},
    "document_cache_backend_error": {"operation", "error_type"},
    "quiz_generation_lock_backend_error": {"operation", "fallback", "error_type"},
    "quiz_cache_backend_error": {"operation", "error_type"},
    "redis_rate_limit_backend_error": {"limiter", "fallback", "error_type"},
    "source_page_cache_backend_error": {"operation", "error_type"},
}
_METRIC_NAMES = frozenset({"http_requests_total", "http_duration_ms_total", "http_5xx_total", "quiz_requests_total", "quiz_duration_ms_total", "quiz_cache_hits_total", "quiz_cache_misses_total", "document_cache_hits_total", "document_cache_misses_total", "quiz_generation_errors_total", "cloud_generation_requests_total", "cloud_generation_model_calls_total", "local_quiz_generations_total", "local_targeted_practice_generations_total"})
_TIMING_NAMES = frozenset(TIMING_SAMPLE_NAMES)
_SNAPSHOT_NUMBER_FIELDS = frozenset({"http_requests_total", "http_5xx_total", "average_http_latency_ms", "quiz_requests_total", "quiz_generation_errors_total", "cloud_generation_requests_total", "cloud_generation_model_calls_total", "local_quiz_generations_total", "local_targeted_practice_generations_total", "average_quiz_latency_ms", "cache_hits_total", "cache_misses_total", "cache_hit_rate_percent", "document_cache_hits_total", "document_cache_misses_total", "document_cache_hit_rate_percent"})
_SNAPSHOT_TIMING_NAMES = frozenset({"http", "quiz", "auth", "document_cache_lookup", "document_cache_write", "pdf_extraction", "openai_generation", "quiz_validation", "quiz_cache_lookup", "quiz_cache_write"})
_HTTP_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"})
_REQUEST_ID_PATTERN = re.compile(r"[a-f0-9]{32}")
_ERROR_TYPES = frozenset({"APIConnectionError", "APITimeoutError", "AttributeError", "AuthenticationError", "BadRequestError", "BusyLoadingError", "ConnectionError", "InternalServerError", "InvalidResponse", "OpenAIError", "RateLimitError", "RedisError", "ResponseError", "RuntimeError", "TimeoutError", "TypeError", "ValidationError", "ValueError"})


def _safe_snapshot(value: Any):
    if not isinstance(value, dict):
        return None
    safe = {key: number for key, number in value.items() if key in _SNAPSHOT_NUMBER_FIELDS and isinstance(number, (int, float)) and not isinstance(number, bool)}
    backend = value.get("metrics_backend")
    if isinstance(backend, str) and backend in {"redis", "memory"}:
        safe["metrics_backend"] = backend
    percentiles = value.get("latency_percentiles_ms")
    if isinstance(percentiles, dict):
        safe["latency_percentiles_ms"] = {
            name: {key: number for key, number in summary.items() if key in {"sample_count", "p50", "p95"} and isinstance(number, (int, float)) and not isinstance(number, bool)}
            for name, summary in percentiles.items()
            if name in _SNAPSHOT_TIMING_NAMES and isinstance(summary, dict)
        }
    return safe


def _safe_log_fields(event: str, fields: dict[str, Any]):
    allowed = _LOG_EVENT_FIELDS.get(event)
    if allowed is None:
        return {}
    safe = {}
    for key, value in fields.items():
        if key not in allowed:
            continue
        if key == "snapshot":
            snapshot = _safe_snapshot(value)
            if snapshot is not None:
                safe[key] = snapshot
        elif key == "metrics":
            if isinstance(value, (list, tuple, set)):
                safe[key] = sorted(item for item in value if isinstance(item, str) and item in _METRIC_NAMES)
        elif key == "timing_name" and isinstance(value, str) and value in _TIMING_NAMES:
            safe[key] = value
        elif key == "error_type" and isinstance(value, str) and value in _ERROR_TYPES:
            safe[key] = value
        elif key == "cache_result" and isinstance(value, str) and value in {"hit", "miss"}:
            safe[key] = value
        elif key == "method" and isinstance(value, str) and value.upper() in _HTTP_METHODS:
            safe[key] = value.upper()
        elif key == "request_id" and isinstance(value, str) and _REQUEST_ID_PATTERN.fullmatch(value):
            safe[key] = value
        elif key == "operation" and isinstance(value, str) and value in {"read", "write", "delete", "acquire", "release", "lookup", "store"}:
            safe[key] = value
        elif key == "fallback" and isinstance(value, str) and value in {"memory", "unlocked_generation", "ttl_expiry"}:
            safe[key] = value
        elif key == "limiter" and isinstance(value, str) and value in {"quiz_generation", "answer_review"}:
            safe[key] = value
        elif key == "reason" and value == "payload_too_large":
            safe[key] = value
        elif key in {"stored", "fallback_stored", "singleflight_waited", "truncated", "remaining_scanned_likely"} and isinstance(value, bool):
            safe[key] = value
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            safe[key] = value
    return safe




def elapsed_ms(started_at: float):
    return round((time.perf_counter() - started_at) * 1000, 2)


def log_event(event: str, *, level: int = logging.INFO, **fields: Any):
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": event if event in _LOG_EVENT_FIELDS else "unclassified",
        **_safe_log_fields(event, fields),
    }
    logger.log(
        level,
        json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ),
    )
    return payload


async def increment_metrics(client, metrics: dict[str, int]):
    normalized_metrics = {
        name: int(amount)
        for name, amount in metrics.items()
        if int(amount) != 0
    }

    if not normalized_metrics:
        return

    if client is not None:
        try:
            pipeline = client.pipeline(transaction=False)
            for metric_name, amount in normalized_metrics.items():
                pipeline.incrby(
                    f"{METRIC_PREFIX}{metric_name}",
                    amount,
                )
            await asyncio.wait_for(
                pipeline.execute(),
                timeout=METRICS_TIMEOUT_SECONDS,
            )
            return
        except (RedisError, AttributeError, asyncio.TimeoutError) as error:
            log_event(
                "metrics_backend_error",
                level=logging.WARNING,
                metrics=list(normalized_metrics),
                error_type=type(error).__name__,
            )

    for metric_name, amount in normalized_metrics.items():
        _memory_metrics[metric_name] += amount


async def increment_metric(client, metric_name: str, amount: int = 1):
    await increment_metrics(client, {metric_name: amount})


async def record_timing_sample(
    client,
    timing_name: str,
    duration_ms: float,
):
    if timing_name not in TIMING_SAMPLE_NAMES:
        return

    normalized_duration = round(
        max(0.0, float(duration_ms)),
        2,
    )

    if client is not None:
        try:
            pipeline = client.pipeline(transaction=False)
            timing_key = f"{TIMING_PREFIX}{timing_name}"
            pipeline.lpush(
                timing_key,
                normalized_duration,
            )
            pipeline.ltrim(
                timing_key,
                0,
                TIMING_SAMPLE_LIMIT - 1,
            )
            await asyncio.wait_for(
                pipeline.execute(),
                timeout=METRICS_TIMEOUT_SECONDS,
            )
            return
        except (RedisError, AttributeError, asyncio.TimeoutError) as error:
            log_event(
                "timing_metrics_backend_error",
                level=logging.WARNING,
                timing_name=timing_name,
                error_type=type(error).__name__,
            )

    _memory_timing_samples[timing_name].append(
        normalized_duration
    )


async def record_document_cache_metric(client, cache_result: str):
    if cache_result == "hit":
        metric_name = "document_cache_hits_total"
    elif cache_result == "miss":
        metric_name = "document_cache_misses_total"
    else:
        return

    await increment_metric(
        client,
        metric_name,
    )



async def record_generation_provider_metric(
    client,
    *,
    provider: str,
    event: str,
):
    allowed = {
        ("cloud", "request"): "cloud_generation_requests_total",
        ("cloud", "model_call"): "cloud_generation_model_calls_total",
        ("local", "quiz_completed"): "local_quiz_generations_total",
        ("local", "targeted_practice_completed"): "local_targeted_practice_generations_total",
    }
    metric_name = allowed.get((provider, event))
    if metric_name is None:
        raise ValueError("Unsupported generation provider metric.")
    await increment_metric(
        client,
        metric_name,
    )

async def record_quiz_metrics(
    client,
    *,
    cache_result: str,
    duration_ms: float,
    failed: bool = False,
):
    metrics = {
        "quiz_requests_total": 1,
        "quiz_duration_ms_total": max(0, int(round(duration_ms))),
    }

    if cache_result == "hit":
        metrics["quiz_cache_hits_total"] = 1
    elif cache_result == "miss":
        metrics["quiz_cache_misses_total"] = 1

    if failed:
        metrics["quiz_generation_errors_total"] = 1

    await increment_metrics(client, metrics)
    await record_timing_sample(
        client,
        "quiz_latency_ms",
        duration_ms,
    )


def get_memory_metric(metric_name: str):
    return _memory_metrics.get(metric_name, 0)


def get_memory_timing_samples(timing_name: str):
    return list(
        _memory_timing_samples.get(
            timing_name,
            (),
        )
    )


async def observe_http_request(request, call_next, metric_client=None):
    request_id = uuid.uuid4().hex
    started_at = time.perf_counter()

    try:
        response = await call_next(request)
    except Exception as error:
        duration = elapsed_ms(started_at)
        await increment_metrics(
            metric_client,
            {
                "http_requests_total": 1,
                "http_duration_ms_total": max(0, int(round(duration))),
                "http_5xx_total": 1,
            },
        )
        await record_timing_sample(
            metric_client,
            "http_latency_ms",
            duration,
        )
        log_event(
            "http_request_failed",
            level=logging.ERROR,
            request_id=request_id,
            method=request.method,
            duration_ms=duration,
            error_type=type(error).__name__,
        )
        response = JSONResponse(
            {"detail": "Internal server error."},
            status_code=500,
        )
        response.headers["X-Request-ID"] = request_id
        return response

    duration = elapsed_ms(started_at)
    metrics = {
        "http_requests_total": 1,
        "http_duration_ms_total": max(0, int(round(duration))),
    }

    if response.status_code >= 500:
        metrics["http_5xx_total"] = 1

    await increment_metrics(metric_client, metrics)
    await record_timing_sample(
        metric_client,
        "http_latency_ms",
        duration,
    )
    response.headers["X-Request-ID"] = request_id

    log_event(
        "http_request_completed",
        request_id=request_id,
        method=request.method,
        status_code=response.status_code,
        duration_ms=duration,
    )
    return response
