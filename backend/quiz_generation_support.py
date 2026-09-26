"""Reusable generation-source and single-flight coordination helpers."""
from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import HTTPException, UploadFile

from processed_documents import normalize_document_sha256
from quiz_service import (
    validate_pdf_content_type,
    validate_pdf_size,
)
from redis_integration import compute_pdf_sha256


async def get_generation_source_identity(
    *,
    document_sha256: str,
    file: UploadFile | None,
    normalize_hash=normalize_document_sha256,
    validate_content_type=validate_pdf_content_type,
    validate_size=validate_pdf_size,
    compute_hash=compute_pdf_sha256,
):
    supplied_hash = (
        document_sha256
        if isinstance(
            document_sha256,
            str,
        )
        else ""
    )

    if supplied_hash.strip():
        normalized_hash = (
            normalize_hash(
                supplied_hash
            )
        )

        if normalized_hash is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Processed document identifier is invalid."
                ),
            )

        return (
            normalized_hash,
            "application/pdf",
            None,
        )

    if file is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Process the PDF before generating a quiz."
            ),
        )

    validate_content_type(
        file.content_type
    )

    contents = await file.read()
    validate_size(contents)

    return (
        compute_hash(contents),
        file.content_type,
        contents,
    )


def get_quiz_generation_poll_delay(
    poll_interval_seconds: float,
    *,
    maximum_interval_seconds: float,
    jitter_ratio: float,
    uniform_fn=None,
):
    bounded_interval = min(
        max(0.0, poll_interval_seconds),
        maximum_interval_seconds,
    )
    jitter_floor = bounded_interval * (
        1 - jitter_ratio
    )

    choose = (
        uniform_fn
        if uniform_fn is not None
        else random.uniform
    )
    return choose(
        max(0.0, jitter_floor),
        bounded_interval,
    )


async def acquire_quiz_generation_turn(
    cache_key: str,
    *,
    use_cached_result: bool,
    try_acquire_lock: Callable[
        [str],
        Awaitable[Any],
    ],
    get_cached_quiz: Callable[
        [str, Any],
        Awaitable[Any],
    ],
    release_lock: Callable[
        [str, str],
        Awaitable[Any],
    ],
    quiz_model: Any,
    wait_seconds: float,
    poll_interval_seconds: float,
    maximum_poll_interval_seconds: float,
    poll_delay_fn: Callable[[float], float],
    sleep_fn=asyncio.sleep,
    monotonic_fn=time.monotonic,
):
    attempt = await try_acquire_lock(
        cache_key
    )

    if not attempt.backend_available:
        return None, None

    if attempt.acquired:
        if use_cached_result:
            cached_quiz = await get_cached_quiz(
                cache_key,
                quiz_model,
            )

            if cached_quiz is not None:
                await release_lock(
                    cache_key,
                    attempt.token,
                )
                return cached_quiz, None

        return None, attempt.token

    deadline = (
        monotonic_fn()
        + wait_seconds
    )
    poll_interval = (
        poll_interval_seconds
    )

    while True:
        remaining_wait = (
            deadline - monotonic_fn()
        )

        if remaining_wait <= 0:
            break

        poll_delay = min(
            poll_delay_fn(
                poll_interval
            ),
            remaining_wait,
        )

        await sleep_fn(poll_delay)

        if monotonic_fn() >= deadline:
            break

        if use_cached_result:
            cached_quiz = await get_cached_quiz(
                cache_key,
                quiz_model,
            )

            if cached_quiz is not None:
                return cached_quiz, None

        attempt = await try_acquire_lock(
            cache_key
        )

        if not attempt.backend_available:
            return None, None

        if not attempt.acquired:
            poll_interval = min(
                poll_interval * 2,
                maximum_poll_interval_seconds,
            )
            continue

        if use_cached_result:
            cached_quiz = await get_cached_quiz(
                cache_key,
                quiz_model,
            )

            if cached_quiz is not None:
                await release_lock(
                    cache_key,
                    attempt.token,
                )
                return cached_quiz, None

        return None, attempt.token

    raise HTTPException(
        status_code=503,
        detail=(
            "Quiz generation is already in progress. "
            "Please retry shortly."
        ),
        headers={
            "Retry-After": "2",
        },
    )
