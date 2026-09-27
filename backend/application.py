import asyncio
import random
import logging
import os
import time

from fastapi import (
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
)

from admin_metrics import get_metric_snapshot
from app_shared import (
    AuthenticatedUser,
    create_app,
    get_current_user,
)
from document_api import (
    UploadResponse,
    build_upload_response_from_sha,
)
from document_retrieval import build_generation_pages
from document_generation_support import (
    get_document_pages_with_cache as resolve_document_pages_with_cache,
    get_generation_pages as resolve_generation_pages,
)
from observability import (
    elapsed_ms,
    log_event,
    observe_http_request,
    record_document_cache_metric,
    record_quiz_metrics,
)
from processed_documents import (
    build_document_cache_key_from_sha,
    build_quiz_cache_key_from_sha,
    forget_processed_document,
    get_processed_document,
    normalize_document_sha256,
    remember_processed_document,
)
import quiz_service
from quiz_service import (
    Quiz,
    generate_quiz_from_pages,
    normalize_quiz_settings,
    validate_pdf_content_type,
    validate_pdf_size,
)
from quiz_generation_support import (
    acquire_quiz_generation_turn as coordinate_quiz_generation_turn,
    get_generation_source_identity as resolve_generation_source_identity,
    get_quiz_generation_poll_delay as calculate_quiz_generation_poll_delay,
)
from quiz_generation_execution import (
    generate_grounded_quiz as execute_grounded_quiz,
)
from redis_integration import (
    QUIZ_GENERATION_POLL_INTERVAL_SECONDS,
    QUIZ_GENERATION_WAIT_SECONDS,
    cache_document,
    cache_quiz,
    compute_pdf_sha256,
    enforce_quiz_rate_limit,
    get_cached_document,
    get_cached_quiz,
    redis_client,
    release_quiz_generation_lock,
    try_acquire_quiz_generation_lock,
)


app = create_app()

QUIZ_GENERATION_POLL_MAX_INTERVAL_SECONDS = 1.0
QUIZ_GENERATION_POLL_JITTER_RATIO = 0.2


async def extract_pdf_pages_off_event_loop(
    contents: bytes,
):
    """Use the shared PDF service without blocking the event loop."""

    return await quiz_service.extract_pdf_pages_off_event_loop(
        contents
    )


async def get_document_pages_with_cache(
    user_id: str,
    contents: bytes,
    pdf_sha256: str | None = None,
):
    return await resolve_document_pages_with_cache(
        user_id=user_id,
        contents=contents,
        pdf_sha256=pdf_sha256,
        compute_hash=compute_pdf_sha256,
        build_cache_key=(
            build_document_cache_key_from_sha
        ),
        get_cached_document=(
            get_cached_document
        ),
        extract_pages=(
            extract_pdf_pages_off_event_loop
        ),
        cache_document=cache_document,
        forget_processed_document=(
            forget_processed_document
        ),
        remember_processed_document=(
            remember_processed_document
        ),
        record_cache_metric=(
            record_document_cache_metric
        ),
        redis_client=redis_client,
        log_event=log_event,
    )

async def get_generation_source_identity(
    *,
    document_sha256: str,
    file: UploadFile | None,
):
    return await resolve_generation_source_identity(
        document_sha256=document_sha256,
        file=file,
        normalize_hash=normalize_document_sha256,
        validate_content_type=(
            validate_pdf_content_type
        ),
        validate_size=validate_pdf_size,
        compute_hash=compute_pdf_sha256,
    )


def get_quiz_generation_poll_delay(
    poll_interval_seconds: float,
):
    return calculate_quiz_generation_poll_delay(
        poll_interval_seconds,
        maximum_interval_seconds=(
            QUIZ_GENERATION_POLL_MAX_INTERVAL_SECONDS
        ),
        jitter_ratio=(
            QUIZ_GENERATION_POLL_JITTER_RATIO
        ),
        uniform_fn=random.uniform,
    )


async def acquire_quiz_generation_turn(
    cache_key: str,
    *,
    use_cached_result: bool,
):
    return await coordinate_quiz_generation_turn(
        cache_key,
        use_cached_result=use_cached_result,
        try_acquire_lock=(
            try_acquire_quiz_generation_lock
        ),
        get_cached_quiz=get_cached_quiz,
        release_lock=(
            release_quiz_generation_lock
        ),
        quiz_model=Quiz,
        wait_seconds=(
            QUIZ_GENERATION_WAIT_SECONDS
        ),
        poll_interval_seconds=(
            QUIZ_GENERATION_POLL_INTERVAL_SECONDS
        ),
        maximum_poll_interval_seconds=(
            QUIZ_GENERATION_POLL_MAX_INTERVAL_SECONDS
        ),
        poll_delay_fn=(
            get_quiz_generation_poll_delay
        ),
        sleep_fn=asyncio.sleep,
        monotonic_fn=time.monotonic,
    )


async def get_generation_pages(
    *,
    user_id: str,
    pdf_sha256: str,
    contents: bytes | None,
):
    return await resolve_generation_pages(
        user_id=user_id,
        pdf_sha256=pdf_sha256,
        contents=contents,
        get_document_pages_with_cache=(
            get_document_pages_with_cache
        ),
        get_processed_document=(
            get_processed_document
        ),
        record_cache_metric=(
            record_document_cache_metric
        ),
        redis_client=redis_client,
        log_event=log_event,
    )

async def generate_grounded_quiz(
    *,
    pages,
    question_count: int,
    difficulty: str,
    question_type: str,
    focus_pages: str,
    focus_question_types: str,
    avoid_questions: str,
    cache_key: str,
):
    return await execute_grounded_quiz(
        pages=pages,
        question_count=question_count,
        difficulty=difficulty,
        question_type=question_type,
        focus_pages=focus_pages,
        focus_question_types=(
            focus_question_types
        ),
        avoid_questions=avoid_questions,
        cache_key=cache_key,
        parse_focus_pages=(
            quiz_service.parse_focus_pages
        ),
        parse_avoid_questions=(
            quiz_service.parse_avoid_questions
        ),
        build_generation_pages=(
            build_generation_pages
        ),
        generate_quiz_from_pages=(
            generate_quiz_from_pages
        ),
        cache_quiz=cache_quiz,
        log_event=log_event,
    )


@app.middleware("http")
async def observability_middleware(
    request,
    call_next,
):
    return await observe_http_request(
        request,
        call_next,
        redis_client,
    )


def get_admin_user_ids():
    return {
        user_id.strip()
        for user_id in os.getenv(
            "ADMIN_USER_IDS",
            "",
        ).split(",")
        if user_id.strip()
    }


async def require_admin(
    current_user: AuthenticatedUser = Depends(
        get_current_user
    ),
):
    if current_user.id not in get_admin_user_ids():
        raise HTTPException(
            status_code=403,
            detail="Admin access is required.",
        )

    return current_user


@app.get("/api/admin/metrics")
async def admin_metrics(
    _current_user: AuthenticatedUser = Depends(
        require_admin
    ),
):
    return await get_metric_snapshot(
        redis_client,
    )


@app.post(
    "/api/documents/upload",
    response_model=UploadResponse,
)
async def upload_pdf(
    file: UploadFile = File(...),
    current_user: AuthenticatedUser = Depends(
        get_current_user
    ),
):
    validate_pdf_content_type(
        file.content_type
    )

    contents = await file.read()
    validate_pdf_size(contents)

    pdf_sha256, pages = (
        await get_document_pages_with_cache(
            user_id=current_user.id,
            contents=contents,
        )
    )

    return build_upload_response_from_sha(
        filename=file.filename,
        pdf_sha256=pdf_sha256,
        pages=pages,
    )


@app.post(
    "/api/quizzes/generate",
    response_model=Quiz,
)
async def generate_quiz(
    file: UploadFile | None = File(None),
    document_sha256: str = Form(""),
    question_count: int = Form(5),
    difficulty: str = Form("medium"),
    question_type: str = Form(
        "multiple_choice"
    ),
    focus_pages: str = Form(""),
    focus_question_types: str = Form(""),
    avoid_questions: str = Form("[]"),
    generate_new_quiz_instead_of_using_cache: bool = Form(False),
    current_user: AuthenticatedUser = Depends(
        get_current_user
    ),
):
    started_at = time.perf_counter()
    cache_result = (
        "bypass"
        if generate_new_quiz_instead_of_using_cache
        else "miss"
    )

    # Redis is the shared rate limiter across backend instances.
    await enforce_quiz_rate_limit(
        current_user.id,
    )

    try:
        (
            question_count,
            difficulty,
            question_type,
        ) = normalize_quiz_settings(
            question_count,
            difficulty,
            question_type,
        )

        (
            pdf_sha256,
            content_type,
            contents,
        ) = await get_generation_source_identity(
            document_sha256=(
                document_sha256
            ),
            file=file,
        )

        cache_key = build_quiz_cache_key_from_sha(
            user_id=current_user.id,
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

        if not generate_new_quiz_instead_of_using_cache:
            cached_quiz = await get_cached_quiz(
                cache_key,
                Quiz,
            )

            if cached_quiz is not None:
                duration = elapsed_ms(
                    started_at,
                )

                await record_quiz_metrics(
                    redis_client,
                    cache_result="hit",
                    duration_ms=duration,
                )

                log_event(
                    "quiz_generation_completed",
                    cache_result="hit",
                    duration_ms=duration,
                    question_count=question_count,
                )

                return cached_quiz

        (
            singleflight_cached_quiz,
            generation_lock_token,
        ) = await acquire_quiz_generation_turn(
            cache_key,
            use_cached_result=(
                not generate_new_quiz_instead_of_using_cache
            ),
        )

        if singleflight_cached_quiz is not None:
            duration = elapsed_ms(
                started_at,
            )

            await record_quiz_metrics(
                redis_client,
                cache_result="hit",
                duration_ms=duration,
            )

            log_event(
                "quiz_generation_completed",
                cache_result="hit",
                duration_ms=duration,
                question_count=question_count,
                singleflight_waited=True,
            )

            return singleflight_cached_quiz

        try:
            pages = await get_generation_pages(
                user_id=current_user.id,
                pdf_sha256=pdf_sha256,
                contents=contents,
            )

            quiz = await generate_grounded_quiz(
                pages=pages,
                question_count=question_count,
                difficulty=difficulty,
                question_type=question_type,
                focus_pages=focus_pages,
                focus_question_types=(
                    focus_question_types
                ),
                avoid_questions=avoid_questions,
                cache_key=cache_key,
            )
        finally:
            if generation_lock_token is not None:
                await release_quiz_generation_lock(
                    cache_key,
                    generation_lock_token,
                )
    except HTTPException as error:
        duration = elapsed_ms(
            started_at,
        )
        failed = error.status_code >= 500

        await record_quiz_metrics(
            redis_client,
            cache_result=cache_result,
            duration_ms=duration,
            failed=failed,
        )

        log_event(
            (
                "quiz_generation_failed"
                if failed
                else "quiz_generation_rejected"
            ),
            level=(
                logging.ERROR
                if failed
                else logging.WARNING
            ),
            cache_result=cache_result,
            duration_ms=duration,
            question_count=question_count,
            status_code=error.status_code,
            error_type=type(error).__name__,
        )

        raise
    except Exception as error:
        duration = elapsed_ms(
            started_at,
        )

        await record_quiz_metrics(
            redis_client,
            cache_result=cache_result,
            duration_ms=duration,
            failed=True,
        )

        log_event(
            "quiz_generation_failed",
            level=logging.ERROR,
            cache_result=cache_result,
            duration_ms=duration,
            question_count=question_count,
            error_type=type(error).__name__,
        )

        raise

    duration = elapsed_ms(
        started_at,
    )

    await record_quiz_metrics(
        redis_client,
        cache_result=cache_result,
        duration_ms=duration,
    )

    log_event(
        "quiz_generation_completed",
        cache_result=cache_result,
        duration_ms=duration,
        question_count=question_count,
    )

    return quiz
