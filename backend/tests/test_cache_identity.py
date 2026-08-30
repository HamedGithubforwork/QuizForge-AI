from cache_identity import (
    build_document_cache_key_from_sha as build_document_identity,
    build_quiz_cache_key_from_sha as build_quiz_identity,
    compute_pdf_sha256,
    normalize_document_sha256,
)
import processed_documents
import redis_integration


CONTENTS = b"same pdf bytes"
PDF_SHA256 = (
    "7625d8eae3dc53619e17755bdec8f8df"
    "ab37382c888797442f7fcc5fe0e7ee38"
)
EXPECTED_DOCUMENT_KEY = (
    "quizforge:document-cache:"
    "f675c954c176935fc73911058a2c7809"
    "adb715bd94f016a8d6367447f9e617c9"
)
EXPECTED_QUIZ_KEY = (
    "quizforge:quiz-cache:"
    "22ae3979898f8492931e0c5267094831"
    "12de8868307d41ab3ba4a3e15f5cd70e"
)


def quiz_key_kwargs():
    return {
        "user_id": "user-1",
        "pdf_sha256": PDF_SHA256,
        "question_count": 7,
        "difficulty": " Medium ",
        "question_type": " Mixed ",
        "focus_pages": " 1, 3 ",
        "focus_question_types": " short_answer ",
        "avoid_questions": " [] ",
        "content_type": "application/pdf",
    }


def test_pdf_sha_and_normalization_are_canonical():
    assert compute_pdf_sha256(CONTENTS) == PDF_SHA256
    assert normalize_document_sha256(
        f"  {PDF_SHA256.upper()}  "
    ) == PDF_SHA256
    assert normalize_document_sha256("not-a-sha") is None


def test_document_cache_key_keeps_existing_fingerprint():
    direct = build_document_identity(
        cache_version="v1",
        user_id="user-1",
        pdf_sha256=PDF_SHA256,
    )
    sha_wrapper = (
        redis_integration.build_document_cache_key_from_sha(
            user_id="user-1",
            pdf_sha256=PDF_SHA256,
        )
    )
    bytes_wrapper = redis_integration.build_document_cache_key(
        user_id="user-1",
        contents=CONTENTS,
    )

    assert direct == EXPECTED_DOCUMENT_KEY
    assert sha_wrapper == direct
    assert bytes_wrapper == direct
    assert (
        processed_documents.build_document_cache_key_from_sha(
            user_id="user-1",
            pdf_sha256=PDF_SHA256,
        )
        == direct
    )


def test_quiz_cache_key_keeps_existing_fingerprint():
    kwargs = quiz_key_kwargs()

    direct = build_quiz_identity(
        cache_version="v1",
        **kwargs,
    )
    sha_wrapper = (
        redis_integration.build_quiz_cache_key_from_sha(
            **kwargs,
        )
    )
    bytes_wrapper = redis_integration.build_quiz_cache_key(
        user_id=kwargs["user_id"],
        contents=CONTENTS,
        question_count=kwargs["question_count"],
        difficulty=kwargs["difficulty"],
        question_type=kwargs["question_type"],
        focus_pages=kwargs["focus_pages"],
        focus_question_types=kwargs[
            "focus_question_types"
        ],
        avoid_questions=kwargs["avoid_questions"],
        content_type=kwargs["content_type"],
    )

    assert direct == EXPECTED_QUIZ_KEY
    assert sha_wrapper == direct
    assert bytes_wrapper == direct
    assert (
        processed_documents.build_quiz_cache_key_from_sha(
            **kwargs,
        )
        == direct
    )


def test_runtime_cache_versions_feed_canonical_helpers():
    document_key = build_document_identity(
        cache_version=(
            redis_integration.DOCUMENT_CACHE_VERSION
        ),
        user_id="user-1",
        pdf_sha256=PDF_SHA256,
    )
    quiz_key = build_quiz_identity(
        cache_version=redis_integration.QUIZ_CACHE_VERSION,
        **quiz_key_kwargs(),
    )

    assert (
        redis_integration.build_document_cache_key_from_sha(
            user_id="user-1",
            pdf_sha256=PDF_SHA256,
        )
        == document_key
    )
    assert (
        redis_integration.build_quiz_cache_key_from_sha(
            **quiz_key_kwargs(),
        )
        == quiz_key
    )
