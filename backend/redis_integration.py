import hashlib
import json
import logging
import os
import time
from collections import defaultdict, deque
from typing import Any

from fastapi import HTTPException
from redis.asyncio import Redis
from redis.exceptions import RedisError

from observability import log_event


def get_positive_int_env(
    name: str,
    default: int,
):
    raw_value = os.getenv(name)

    if not raw_value:
        return default

    try:
        value = int(raw_value)
    except ValueError:
        return default

    return max(1, value)


REDIS_URL = os.getenv(
    "REDIS_URL",
    "",
).strip()

QUIZ_RATE_LIMIT = get_positive_int_env(
    "QUIZ_RATE_LIMIT",
    10,
)

QUIZ_RATE_WINDOW_SECONDS = get_positive_int_env(
    "QUIZ_RATE_WINDOW_SECONDS",
    600,
)

QUIZ_CACHE_TTL_SECONDS = get_positive_int_env(
    "QUIZ_CACHE_TTL_SECONDS",
    3600,
)

QUIZ_CACHE_VERSION = (
    os.getenv(
        "QUIZ_CACHE_VERSION",
        "v1",
    ).strip()
    or "v1"
)

DOCUMENT_CACHE_TTL_SECONDS = get_positive_int_env(
    "DOCUMENT_CACHE_TTL_SECONDS",
    86400,
)

DOCUMENT_CACHE_MAX_BYTES = get_positive_int_env(
    "DOCUMENT_CACHE_MAX_BYTES",
    1_500_000,
)

DOCUMENT_CACHE_VERSION = (
    os.getenv(
        "DOCUMENT_CACHE_VERSION",
        "v1",
    ).strip()
    or "v1"
)


redis_client = (
    Redis.from_url(
        REDIS_URL,
        encoding="utf-8",
        decode_responses=True,
        socket_connect_timeout=1.5,
        socket_timeout=1.5,
    )
    if REDIS_URL
    else None
)


_memory_generation_requests: dict[
    str,
    deque[float],
] = defaultdict(deque)


RATE_LIMIT_SCRIPT = """
local current = redis.call('INCR', KEYS[1])

if current == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
end

local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
"""


def _raise_rate_limit(wait_seconds: int):
    raise HTTPException(
        status_code=429,
        detail=(
            "Too many quiz generation "
            "requests. Please wait before "
            "trying again."
        ),
        headers={
            "Retry-After": str(
                max(1, wait_seconds)
            ),
        },
    )


def _enforce_memory_rate_limit(
    user_id: str,
):
    now = time.monotonic()

    request_times = (
        _memory_generation_requests[user_id]
    )

    cutoff = (
        now
        - QUIZ_RATE_WINDOW_SECONDS
    )

    while (
        request_times
        and request_times[0] <= cutoff
    ):
        request_times.popleft()

    if (
        len(request_times)
        >= QUIZ_RATE_LIMIT
    ):
        wait_seconds = max(
            1,
            int(
                QUIZ_RATE_WINDOW_SECONDS
                - (
                    now
                    - request_times[0]
                )
            )
            + 1,
        )

        _raise_rate_limit(
            wait_seconds,
        )

    request_times.append(now)


async def enforce_quiz_rate_limit(
    user_id: str,
    client: Any = None,
):
    selected_client = (
        client
        if client is not None
        else redis_client
    )

    if selected_client is not None:
        try:
            result = await selected_client.eval(
                RATE_LIMIT_SCRIPT,
                1,
                f"quizforge:rate:{user_id}",
                QUIZ_RATE_WINDOW_SECONDS,
            )
        except RedisError as error:
            log_event(
                "redis_rate_limit_backend_error",
                level=logging.WARNING,
                fallback="memory",
                error_type=type(error).__name__,
            )
        else:
            request_count = int(
                result[0]
            )
            ttl = max(
                1,
                int(result[1]),
            )

            if request_count > QUIZ_RATE_LIMIT:
                _raise_rate_limit(
                    ttl,
                )

            return

    _enforce_memory_rate_limit(
        user_id,
    )


def compute_pdf_sha256(
    contents: bytes,
):
    return hashlib.sha256(
        contents
    ).hexdigest()


def build_document_cache_key(
    user_id: str,
    contents: bytes,
):
    request_data = {
        "cache_version": DOCUMENT_CACHE_VERSION,
        "user_id": user_id,
        "pdf_sha256": compute_pdf_sha256(
            contents
        ),
    }

    fingerprint = hashlib.sha256(
        json.dumps(
            request_data,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    return (
        "quizforge:document-cache:"
        f"{fingerprint}"
    )


async def get_cached_document(
    cache_key: str,
    client: Any = None,
):
    selected_client = (
        client
        if client is not None
        else redis_client
    )

    if selected_client is None:
        return None

    try:
        cached_value = await selected_client.get(
            cache_key
        )
    except RedisError as error:
        log_event(
            "document_cache_backend_error",
            level=logging.WARNING,
            operation="read",
            error_type=type(error).__name__,
        )
        return None

    if not cached_value:
        return None

    try:
        cached_document = json.loads(
            cached_value
        )
    except (TypeError, json.JSONDecodeError):
        return None

    if (
        not isinstance(cached_document, dict)
        or not isinstance(
            cached_document.get("pdf_sha256"),
            str,
        )
        or not isinstance(
            cached_document.get("pages"),
            list,
        )
    ):
        return None

    return cached_document


async def cache_document(
    cache_key: str,
    document: dict,
    client: Any = None,
):
    selected_client = (
        client
        if client is not None
        else redis_client
    )

    if selected_client is None:
        return False

    serialized_document = json.dumps(
        document,
        separators=(",", ":"),
        ensure_ascii=False,
    )

    if (
        len(
            serialized_document.encode(
                "utf-8"
            )
        )
        > DOCUMENT_CACHE_MAX_BYTES
    ):
        log_event(
            "document_cache_store_skipped",
            reason="payload_too_large",
        )
        return False

    try:
        await selected_client.set(
            cache_key,
            serialized_document,
            ex=DOCUMENT_CACHE_TTL_SECONDS,
        )
    except RedisError as error:
        log_event(
            "document_cache_backend_error",
            level=logging.WARNING,
            operation="write",
            error_type=type(error).__name__,
        )
        return False

    return True


def build_quiz_cache_key(
    user_id: str,
    contents: bytes,
    question_count: int,
    difficulty: str,
    question_type: str,
    focus_pages: str,
    focus_question_types: str,
    avoid_questions: str,
    content_type: str | None,
):
    request_data = {
        "cache_version": QUIZ_CACHE_VERSION,
        "user_id": user_id,
        "pdf_sha256": compute_pdf_sha256(
            contents
        ),
        "content_type": content_type or "",
        "question_count": question_count,
        "difficulty": difficulty.strip().lower(),
        "question_type": question_type.strip().lower(),
        "focus_pages": focus_pages.strip(),
        "focus_question_types": (
            focus_question_types.strip()
        ),
        "avoid_questions": avoid_questions.strip(),
    }

    fingerprint = hashlib.sha256(
        json.dumps(
            request_data,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    return (
        "quizforge:quiz-cache:"
        f"{fingerprint}"
    )


async def get_cached_quiz(
    cache_key: str,
    quiz_model,
    client: Any = None,
):
    selected_client = (
        client
        if client is not None
        else redis_client
    )

    if selected_client is None:
        return None

    try:
        cached_value = await selected_client.get(
            cache_key
        )
    except RedisError as error:
        log_event(
            "quiz_cache_backend_error",
            level=logging.WARNING,
            operation="read",
            error_type=type(error).__name__,
        )
        return None

    if not cached_value:
        return None

    try:
        cached_quiz = quiz_model.model_validate_json(
            cached_value
        )
    except ValueError:
        return None

    return cached_quiz


async def cache_quiz(
    cache_key: str,
    quiz,
    client: Any = None,
):
    selected_client = (
        client
        if client is not None
        else redis_client
    )

    if selected_client is None:
        return

    try:
        await selected_client.set(
            cache_key,
            quiz.model_dump_json(),
            ex=QUIZ_CACHE_TTL_SECONDS,
        )
    except RedisError as error:
        log_event(
            "quiz_cache_backend_error",
            level=logging.WARNING,
            operation="write",
            error_type=type(error).__name__,
        )
