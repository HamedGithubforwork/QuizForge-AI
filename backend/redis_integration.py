import hashlib
import json
import logging
import os
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException
from redis.asyncio import Redis
from redis.exceptions import RedisError

from cache_identity import (
    build_document_cache_key_from_sha as build_document_cache_identity,
    build_quiz_cache_key_from_sha as build_quiz_cache_identity,
    compute_pdf_sha256,
)
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

ANSWER_REVIEW_RATE_LIMIT = get_positive_int_env(
    "ANSWER_REVIEW_RATE_LIMIT",
    20,
)

ANSWER_REVIEW_RATE_WINDOW_SECONDS = get_positive_int_env(
    "ANSWER_REVIEW_RATE_WINDOW_SECONDS",
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

QUIZ_GENERATION_LOCK_TTL_SECONDS = get_positive_int_env(
    "QUIZ_GENERATION_LOCK_TTL_SECONDS",
    120,
)

QUIZ_GENERATION_WAIT_SECONDS = get_positive_int_env(
    "QUIZ_GENERATION_WAIT_SECONDS",
    30,
)

QUIZ_GENERATION_POLL_INTERVAL_SECONDS = 0.1

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

_memory_answer_review_requests: dict[
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


RELEASE_QUIZ_GENERATION_LOCK_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end

return 0
"""


QUIZ_RATE_LIMIT_DETAIL = (
    "Too many quiz generation requests. "
    "Please wait before trying again."
)

ANSWER_REVIEW_RATE_LIMIT_DETAIL = (
    "Too many semantic answer review requests. "
    "Please wait before trying again."
)


@dataclass(frozen=True)
class QuizGenerationLockAttempt:
    backend_available: bool
    acquired: bool
    token: str | None = None


def _raise_rate_limit(
    wait_seconds: int,
    detail: str,
):
    raise HTTPException(
        status_code=429,
        detail=detail,
        headers={
            "Retry-After": str(
                max(1, wait_seconds)
            ),
        },
    )


def _enforce_memory_rate_limit(
    user_id: str,
    *,
    request_store: dict[str, deque[float]],
    limit: int,
    window_seconds: int,
    detail: str,
):
    now = time.monotonic()

    request_times = request_store[user_id]

    cutoff = now - window_seconds

    while (
        request_times
        and request_times[0] <= cutoff
    ):
        request_times.popleft()

    if len(request_times) >= limit:
        wait_seconds = max(
            1,
            int(
                window_seconds
                - (
                    now
                    - request_times[0]
                )
            )
            + 1,
        )

        _raise_rate_limit(
            wait_seconds,
            detail,
        )

    request_times.append(now)


async def _enforce_distributed_rate_limit(
    user_id: str,
    *,
    redis_key: str,
    limit: int,
    window_seconds: int,
    detail: str,
    memory_store: dict[str, deque[float]],
    limiter_name: str,
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
                redis_key,
                window_seconds,
            )
        except RedisError as error:
            log_event(
                "redis_rate_limit_backend_error",
                level=logging.WARNING,
                limiter=limiter_name,
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

            if request_count > limit:
                _raise_rate_limit(
                    ttl,
                    detail,
                )

            return

    _enforce_memory_rate_limit(
        user_id,
        request_store=memory_store,
        limit=limit,
        window_seconds=window_seconds,
        detail=detail,
    )


async def enforce_quiz_rate_limit(
    user_id: str,
    client: Any = None,
):
    await _enforce_distributed_rate_limit(
        user_id,
        redis_key=f"quizforge:rate:{user_id}",
        limit=QUIZ_RATE_LIMIT,
        window_seconds=(
            QUIZ_RATE_WINDOW_SECONDS
        ),
        detail=QUIZ_RATE_LIMIT_DETAIL,
        memory_store=(
            _memory_generation_requests
        ),
        limiter_name="quiz_generation",
        client=client,
    )


async def enforce_answer_review_rate_limit(
    user_id: str,
    client: Any = None,
):
    await _enforce_distributed_rate_limit(
        user_id,
        redis_key=(
            "quizforge:rate:answer-review:"
            f"{user_id}"
        ),
        limit=ANSWER_REVIEW_RATE_LIMIT,
        window_seconds=(
            ANSWER_REVIEW_RATE_WINDOW_SECONDS
        ),
        detail=(
            ANSWER_REVIEW_RATE_LIMIT_DETAIL
        ),
        memory_store=(
            _memory_answer_review_requests
        ),
        limiter_name="answer_review",
        client=client,
    )


def build_document_cache_key_from_sha(
    *,
    user_id: str,
    pdf_sha256: str,
):
    return build_document_cache_identity(
        cache_version=DOCUMENT_CACHE_VERSION,
        user_id=user_id,
        pdf_sha256=pdf_sha256,
    )


def build_document_cache_key(
    user_id: str,
    contents: bytes,
):
    return build_document_cache_key_from_sha(
        user_id=user_id,
        pdf_sha256=compute_pdf_sha256(
            contents
        ),
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


def build_quiz_cache_key_from_sha(
    *,
    user_id: str,
    pdf_sha256: str,
    question_count: int,
    difficulty: str,
    question_type: str,
    focus_pages: str,
    focus_question_types: str,
    avoid_questions: str,
    content_type: str | None,
):
    return build_quiz_cache_identity(
        cache_version=QUIZ_CACHE_VERSION,
        user_id=user_id,
        pdf_sha256=pdf_sha256,
        question_count=question_count,
        difficulty=difficulty,
        question_type=question_type,
        focus_pages=focus_pages,
        focus_question_types=(
            focus_question_types
        ),
        avoid_questions=avoid_questions,
        content_type=content_type,
    )


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
    return build_quiz_cache_key_from_sha(
        user_id=user_id,
        pdf_sha256=compute_pdf_sha256(
            contents
        ),
        question_count=question_count,
        difficulty=difficulty,
        question_type=question_type,
        focus_pages=focus_pages,
        focus_question_types=(
            focus_question_types
        ),
        avoid_questions=avoid_questions,
        content_type=content_type,
    )


def build_quiz_generation_lock_key(
    cache_key: str,
):
    cache_prefix = "quizforge:quiz-cache:"

    fingerprint = (
        cache_key.removeprefix(cache_prefix)
        if cache_key.startswith(cache_prefix)
        else hashlib.sha256(
            cache_key.encode("utf-8")
        ).hexdigest()
    )

    return (
        "quizforge:quiz-generation-lock:"
        f"{fingerprint}"
    )


async def try_acquire_quiz_generation_lock(
    cache_key: str,
    client: Any = None,
):
    selected_client = (
        client
        if client is not None
        else redis_client
    )

    if selected_client is None:
        return QuizGenerationLockAttempt(
            backend_available=False,
            acquired=False,
        )

    lock_key = build_quiz_generation_lock_key(
        cache_key
    )
    token = uuid.uuid4().hex

    try:
        acquired = await selected_client.set(
            lock_key,
            token,
            nx=True,
            ex=QUIZ_GENERATION_LOCK_TTL_SECONDS,
        )
    except RedisError as error:
        log_event(
            "quiz_generation_lock_backend_error",
            level=logging.WARNING,
            operation="acquire",
            fallback="unlocked_generation",
            error_type=type(error).__name__,
        )
        return QuizGenerationLockAttempt(
            backend_available=False,
            acquired=False,
        )

    if not acquired:
        return QuizGenerationLockAttempt(
            backend_available=True,
            acquired=False,
        )

    return QuizGenerationLockAttempt(
        backend_available=True,
        acquired=True,
        token=token,
    )


async def release_quiz_generation_lock(
    cache_key: str,
    token: str | None,
    client: Any = None,
):
    if not token:
        return False

    selected_client = (
        client
        if client is not None
        else redis_client
    )

    if selected_client is None:
        return False

    lock_key = build_quiz_generation_lock_key(
        cache_key
    )

    try:
        released = await selected_client.eval(
            RELEASE_QUIZ_GENERATION_LOCK_SCRIPT,
            1,
            lock_key,
            token,
        )
    except RedisError as error:
        log_event(
            "quiz_generation_lock_backend_error",
            level=logging.WARNING,
            operation="release",
            fallback="ttl_expiry",
            error_type=type(error).__name__,
        )
        return False

    return bool(released)


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
