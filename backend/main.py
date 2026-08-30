import time
from collections import defaultdict, deque

from fastapi import (
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
)

from app_shared import (
    AuthenticatedUser,
    create_app,
    get_current_user,
    get_positive_int_env,
)
from document_api import UploadResponse
from processed_documents import (
    remember_processed_document,
)
from quiz_service import (
    MAX_AI_CHARACTERS,
    MAX_FILE_SIZE,
    MIN_EXTRACTABLE_CHARACTERS,
    SCAN_CHARACTERS_PER_PAGE,
    Quiz,
    QuizQuestion,
    ShortAnswerGradingSpec,
    analyze_extracted_text,
    build_upload_response,
    extract_pdf_pages,
    extract_pdf_pages_off_event_loop,
    generate_quiz_from_pages,
    normalize_quiz_settings,
    parse_avoid_questions,
    parse_focus_pages,
    parse_focus_question_types,
    validate_pdf_content_type,
    validate_pdf_size,
)


QUIZ_RATE_LIMIT = get_positive_int_env(
    "QUIZ_RATE_LIMIT",
    10,
)

QUIZ_RATE_WINDOW_SECONDS = (
    get_positive_int_env(
        "QUIZ_RATE_WINDOW_SECONDS",
        600,
    )
)


_generation_requests: dict[
    str,
    deque[float],
] = defaultdict(deque)


def enforce_quiz_rate_limit(
    user_id: str,
):
    now = time.monotonic()
    request_times = (
        _generation_requests[user_id]
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

        raise HTTPException(
            status_code=429,
            detail=(
                "Too many quiz generation "
                "requests. Please wait before "
                "trying again."
            ),
            headers={
                "Retry-After": str(
                    wait_seconds
                ),
            },
        )

    request_times.append(now)


app = create_app()


@app.post(
    "/api/documents/upload",
    response_model=UploadResponse,
)
async def upload_pdf(
    file: UploadFile = File(...),
    _current_user: AuthenticatedUser = Depends(
        get_current_user
    ),
):
    validate_pdf_content_type(
        file.content_type
    )

    contents = await file.read()
    validate_pdf_size(contents)

    pages = await extract_pdf_pages_off_event_loop(
        contents
    )

    response = build_upload_response(
        file.filename,
        contents,
        pages,
    )

    remember_processed_document(
        user_id=_current_user.id,
        pdf_sha256=response["pdf_sha256"],
        pages=pages,
    )

    return response


@app.post(
    "/api/quizzes/generate",
    response_model=Quiz,
)
async def generate_quiz(
    file: UploadFile = File(...),
    question_count: int = Form(5),
    difficulty: str = Form("medium"),
    question_type: str = Form(
        "multiple_choice"
    ),
    focus_pages: str = Form(""),
    focus_question_types: str = Form(""),
    avoid_questions: str = Form("[]"),
    current_user: AuthenticatedUser = Depends(
        get_current_user
    ),
):
    enforce_quiz_rate_limit(
        current_user.id,
    )

    validate_pdf_content_type(
        file.content_type
    )

    (
        question_count,
        difficulty,
        question_type,
    ) = normalize_quiz_settings(
        question_count,
        difficulty,
        question_type,
    )

    contents = await file.read()
    validate_pdf_size(contents)

    pages = await extract_pdf_pages_off_event_loop(
        contents
    )

    return await generate_quiz_from_pages(
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
