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


logger = logging.getLogger(
    "quizforge.observability"
)

if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter("%(message)s")
    )
    logger.addHandler(handler)

log_level_name = os.getenv(
    "LOG_LEVEL",
    "INFO",
).strip().upper()

logger.setLevel(
    getattr(
        logging,
        log_level_name,
        logging.INFO,
    )
)
logger.propagate = False


_memory_metrics: dict[str, int] = defaultdict(int)


def elapsed_ms(started_at: float):
    return round(
        (time.perf_counter() - started_at)
        * 1000,
        2,
    )


def log_event(
    event: str,
    *,
    level: int = logging.INFO,
    **fields: Any,
):
    payload = {
        "timestamp": datetime.now(
            timezone.utc
        ).isoformat(),
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


async def increment_metric(
    client,
    metric_name: str,
    amount: int = 1,
):
    normalized_amount = int(amount)

    if client is not None:
        try:
            await client.incrby(
                f"{METRIC_PREFIX}{metric_name}",
                normalized_amount,
            )
            return
        except (RedisError, AttributeError) as error:
            log_event(
                "metrics_backend_error",
                level=logging.WARNING,
                metric=metric_name,
                error_type=type(error).__name__,
            )

    _memory_metrics[metric_name] += (
        normalized_amount
    )


async def record_quiz_metrics(
    client,
    *,
    cache_result: str,
    duration_ms: float,
    failed: bool = False,
):
    await increment_metric(
        client,
        "quiz_requests_total",
    )
    await increment_metric(
        client,
        "quiz_duration_ms_total",
        max(
            0,
            int(round(duration_ms)),
        ),
    )

    if cache_result == "hit":
        await increment_metric(
            client,
            "quiz_cache_hits_total",
        )
    elif cache_result == "miss":
        await increment_metric(
            client,
            "quiz_cache_misses_total",
        )

    if failed:
        await increment_metric(
            client,
            "quiz_generation_errors_total",
        )


def get_memory_metric(metric_name: str):
    return _memory_metrics.get(
        metric_name,
        0,
    )


async def observe_http_request(
    request,
    call_next,
    metric_client=None,
):
    request_id = uuid.uuid4().hex
    started_at = time.perf_counter()

    try:
        response = await call_next(request)
    except Exception as error:
        duration = elapsed_ms(started_at)

        await increment_metric(
            metric_client,
            "http_requests_total",
        )
        await increment_metric(
            metric_client,
            "http_duration_ms_total",
            max(
                0,
                int(round(duration)),
            ),
        )
        await increment_metric(
            metric_client,
            "http_5xx_total",
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

    await increment_metric(
        metric_client,
        "http_requests_total",
    )
    await increment_metric(
        metric_client,
        "http_duration_ms_total",
        max(
            0,
            int(round(duration)),
        ),
    )

    if response.status_code >= 500:
        await increment_metric(
            metric_client,
            "http_5xx_total",
        )

    response.headers[
        "X-Request-ID"
    ] = request_id

    log_event(
        "http_request_completed",
        request_id=request_id,
        method=request.method,
        path=request.url.path,
        status_code=response.status_code,
        duration_ms=duration,
    )

    return response
