import asyncio
import json
import logging
import os
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from redis.exceptions import RedisError


METRIC_PREFIX = "quizforge:metrics:"
METRICS_TIMEOUT_SECONDS = 0.25

logger = logging.getLogger("quizforge.observability")

if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)

log_level_name = os.getenv("LOG_LEVEL", "INFO").strip().upper()
logger.setLevel(getattr(logging, log_level_name, logging.INFO))
logger.propagate = False

_memory_metrics: dict[str, int] = defaultdict(int)


def elapsed_ms(started_at: float):
    return round((time.perf_counter() - started_at) * 1000, 2)


def log_event(event: str, *, level: int = logging.INFO, **fields: Any):
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **fields,
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


def get_memory_metric(metric_name: str):
    return _memory_metrics.get(metric_name, 0)


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
        log_event(
            "http_request_failed",
            level=logging.ERROR,
            request_id=request_id,
            method=request.method,
            path=request.url.path,
            duration_ms=duration,
            error_type=type(error).__name__,
        )
        raise

    duration = elapsed_ms(started_at)
    metrics = {
        "http_requests_total": 1,
        "http_duration_ms_total": max(0, int(round(duration))),
    }

    if response.status_code >= 500:
        metrics["http_5xx_total"] = 1

    await increment_metrics(metric_client, metrics)
    response.headers["X-Request-ID"] = request_id

    log_event(
        "http_request_completed",
        request_id=request_id,
        method=request.method,
        path=request.url.path,
        status_code=response.status_code,
        duration_ms=duration,
    )
    return response
