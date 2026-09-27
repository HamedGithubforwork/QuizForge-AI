import logging
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from fastapi import HTTPException

from observability import elapsed_ms


@dataclass(frozen=True)
class QuizGenerationRuntime:
    quiz_model: type
    redis_client: Any
    enforce_rate_limit: Callable[..., Awaitable[Any]]
    normalize_settings: Callable[..., tuple[int, str, str]]
    get_source_identity: Callable[..., Awaitable[Any]]
    build_cache_key: Callable[..., str]
    get_cached_quiz: Callable[..., Awaitable[Any]]
    record_metrics: Callable[..., Awaitable[Any]]
    log_event: Callable[..., Any]
    acquire_generation_turn: Callable[..., Awaitable[Any]]
    get_generation_pages: Callable[..., Awaitable[Any]]
    generate_grounded_quiz: Callable[..., Awaitable[Any]]
    release_generation_lock: Callable[..., Awaitable[Any]]


async def _record_quiz_outcome(
    runtime: QuizGenerationRuntime,
    *,
    started_at: float,
    cache_result: str,
    question_count: int,
    event: str,
    failed: bool = False,
    level: int | None = None,
    **fields,
):
    duration = elapsed_ms(started_at)

    await runtime.record_metrics(
        runtime.redis_client,
        cache_result=cache_result,
        duration_ms=duration,
        failed=failed,
    )

    event_fields = {
        "cache_result": cache_result,
        "duration_ms": duration,
        "question_count": question_count,
        **fields,
    }

    if level is None:
        runtime.log_event(
            event,
            **event_fields,
        )
    else:
        runtime.log_event(
            event,
            level=level,
            **event_fields,
        )


async def generate_quiz_response(
    *,
    file,
    document_sha256: str,
    question_count: int,
    difficulty: str,
    question_type: str,
    focus_pages: str,
    focus_question_types: str,
    avoid_questions: str,
    generate_new_quiz_instead_of_using_cache: bool,
    current_user,
    runtime: QuizGenerationRuntime,
):
    started_at = time.perf_counter()
    cache_result = (
        "bypass"
        if generate_new_quiz_instead_of_using_cache
        else "miss"
    )

    await runtime.enforce_rate_limit(
        current_user.id,
    )

    try:
        (
            question_count,
            difficulty,
            question_type,
        ) = runtime.normalize_settings(
            question_count,
            difficulty,
            question_type,
        )

        (
            pdf_sha256,
            content_type,
            contents,
        ) = await runtime.get_source_identity(
            document_sha256=document_sha256,
            file=file,
        )

        cache_key = runtime.build_cache_key(
            user_id=current_user.id,
            pdf_sha256=pdf_sha256,
            question_count=question_count,
            difficulty=difficulty,
            question_type=question_type,
            focus_pages=focus_pages,
            focus_question_types=focus_question_types,
            avoid_questions=avoid_questions,
            content_type=content_type,
        )

        if not generate_new_quiz_instead_of_using_cache:
            cached_quiz = await runtime.get_cached_quiz(
                cache_key,
                runtime.quiz_model,
            )

            if cached_quiz is not None:
                await _record_quiz_outcome(
                    runtime,
                    started_at=started_at,
                    cache_result="hit",
                    question_count=question_count,
                    event="quiz_generation_completed",
                )
                return cached_quiz

        (
            singleflight_cached_quiz,
            generation_lock_token,
        ) = await runtime.acquire_generation_turn(
            cache_key,
            use_cached_result=(
                not generate_new_quiz_instead_of_using_cache
            ),
        )

        if singleflight_cached_quiz is not None:
            await _record_quiz_outcome(
                runtime,
                started_at=started_at,
                cache_result="hit",
                question_count=question_count,
                event="quiz_generation_completed",
                singleflight_waited=True,
            )
            return singleflight_cached_quiz

        try:
            pages = await runtime.get_generation_pages(
                user_id=current_user.id,
                pdf_sha256=pdf_sha256,
                contents=contents,
            )

            quiz = await runtime.generate_grounded_quiz(
                pages=pages,
                question_count=question_count,
                difficulty=difficulty,
                question_type=question_type,
                focus_pages=focus_pages,
                focus_question_types=focus_question_types,
                avoid_questions=avoid_questions,
                cache_key=cache_key,
            )
        finally:
            if generation_lock_token is not None:
                await runtime.release_generation_lock(
                    cache_key,
                    generation_lock_token,
                )
    except HTTPException as error:
        failed = error.status_code >= 500

        await _record_quiz_outcome(
            runtime,
            started_at=started_at,
            cache_result=cache_result,
            question_count=question_count,
            event=(
                "quiz_generation_failed"
                if failed
                else "quiz_generation_rejected"
            ),
            failed=failed,
            level=(
                logging.ERROR
                if failed
                else logging.WARNING
            ),
            status_code=error.status_code,
            error_type=type(error).__name__,
        )
        raise
    except Exception as error:
        await _record_quiz_outcome(
            runtime,
            started_at=started_at,
            cache_result=cache_result,
            question_count=question_count,
            event="quiz_generation_failed",
            failed=True,
            level=logging.ERROR,
            error_type=type(error).__name__,
        )
        raise

    await _record_quiz_outcome(
        runtime,
        started_at=started_at,
        cache_result=cache_result,
        question_count=question_count,
        event="quiz_generation_completed",
    )

    return quiz
