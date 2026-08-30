import asyncio
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
from observability import (
    elapsed_ms,
    log_event,
    observe_http_request,
    record_document_cache_metric,
    record_quiz_metrics,
)
from processed_documents import (
    build_quiz_cache_key_from_sha,
    get_processed_document,
    normalize_document_sha256,
    remember_processed_document,
)
import quiz_service
from quiz_service import (
    Quiz,
    build_upload_response,
    generate_quiz_from_pages,
    normalize_quiz_settings,
    validate_pdf_content_type,
    validate_pdf_size,
)
from redis_integration import (
    QUIZ_GENERATION_POLL_INTERVAL_SECONDS,
    QUIZ_GENERATION_WAIT_SECONDS,
    build_document_cache_key,
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
):
    pdf_sha256 = compute_pdf_sha256(
        contents
    )

    cache_key = build_document_cache_key(
        user_id=user_id,
        contents=contents,
    )

    cached_document = await get_cached_document(
        cache_key
    )

    if cached_document is not None:
        await record_document_cache_metric(
            redis_client,
            "hit",
        )

        log_event(
            "document_cache_lookup",
            cache_result="hit",
            page_count=len(
                cached_document["pages"]
            ),
        )

        return (
            cached_document["pdf_sha256"],
            cached_document["pages"],
        )

    pages = await extract_pdf_pages_off_event_loop(
        contents
    )

    cached = await cache_document(
        cache_key,
        {
            "pdf_sha256": pdf_sha256,
            "pages": pages,
        },
    )

    await record_document_cache_metric(
        redis_client,
        "miss",
    )

    log_event(
        "document_cache_lookup",
        cache_result="miss",
        page_count=len(pages),
        stored=cached,
    )

    return pdf_sha256, pages


async def get_generation_document(
    *,
    user_id: str,
    document_sha256: str,
    file: UploadFile | None,
):
    if document_sha256.strip():
        normalized_hash = (
            normalize_document_sha256(
                document_sha256
            )
        )

        if normalized_hash is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Processed document identifier is invalid."
                ),
            )

        document = await get_processed_document(
            user_id=user_id,
            pdf_sha256=normalized_hash,
        )

        if document is None:
            await record_document_cache_metric(
                redis_client,
                "miss",
            )

            log_event(
                "processed_document_lookup",
                cache_result="miss",
            )

            raise HTTPException(
                status_code=410,
                detail=(
                    "Processed document expired or is unavailable. "
                    "Please process the PDF again."
                ),
            )

        await record_document_cache_metric(
            redis_client,
            "hit",
        )

        log_event(
            "processed_document_lookup",
            cache_result="hit",
            page_count=len(
                document["pages"]
            ),
        )

        return (
            normalized_hash,
            document["pages"],
            "application/pdf",
        )

    if file is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Process the PDF before generating a quiz."
            ),
        )

    validate_pdf_content_type(
        file.content_type
    )

    contents = await file.read()
    validate_pdf_size(contents)

    pdf_sha256, pages = (
        await get_document_pages_with_cache(
            user_id=user_id,
            contents=contents,
        )
    )

    remember_processed_document(
        user_id=user_id,
        pdf_sha256=pdf_sha256,
        pages=pages,
    )

    return (
        pdf_sha256,
        pages,
        file.content_type,
    )


async def acquire_quiz_generation_turn(
    cache_key: str,
    *,
    use_cached_result: bool,
):
    attempt = await try_acquire_quiz_generation_lock(
        cache_key
    )

    if not attempt.backend_available:
        return None, None

    if attempt.acquired:
        if use_cached_result:
            cached_quiz = await get_cached_quiz(
                cache_key,
                Quiz,
            )

            if cached_quiz is not None:
                await release_quiz_generation_lock(
                    cache_key,
                    attempt.token,
                )
                return cached_quiz, None

        return None, attempt.token

    deadline = (
        time.monotonic()
        + QUIZ_GENERATION_WAIT_SECONDS
    )

    while time.monotonic() < deadline:
        await asyncio.sleep(
            QUIZ_GENERATION_POLL_INTERVAL_SECONDS
        )

        if use_cached_result:
            cached_quiz = await get_cached_quiz(
                cache_key,
                Quiz,
            )

            if cached_quiz is not None:
                return cached_quiz, None

        attempt = await try_acquire_quiz_generation_lock(
            cache_key
        )

        if not attempt.backend_available:
            return None, None

        if not attempt.acquired:
            continue

        if use_cached_result:
            cached_quiz = await get_cached_quiz(
                cache_key,
                Quiz,
            )

            if cached_quiz is not None:
                await release_quiz_generation_lock(
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


@app.post("/api/documents/upload")
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

    remember_processed_document(
        user_id=current_user.id,
        pdf_sha256=pdf_sha256,
        pages=pages,
    )

    return build_upload_response(
        file.filename,
        contents,
        pages,
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
            pages,
            content_type,
        ) = await get_generation_document(
            user_id=current_user.id,
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
            quiz = await generate_quiz_from_pages(
                pages=pages,
                question_count=question_count,
                difficulty=difficulty,
                question_type=question_type,
                focus_pages=focus_pages,
                focus_question_types=(
                    focus_question_types
                ),
                avoid_questions=avoid_questions,
            )

            # A requested new generation replaces the older cached quiz.
            await cache_quiz(
                cache_key,
                quiz,
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
