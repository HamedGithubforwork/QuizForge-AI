import hashlib
import json


DOCUMENT_CACHE_PREFIX = "quizforge:document-cache:"
QUIZ_CACHE_PREFIX = "quizforge:quiz-cache:"


def compute_pdf_sha256(contents: bytes):
    return hashlib.sha256(contents).hexdigest()


def normalize_document_sha256(value: str | None):
    normalized = (value or "").strip().lower()

    if len(normalized) != 64:
        return None

    if any(
        character not in "0123456789abcdef"
        for character in normalized
    ):
        return None

    return normalized


def _build_cache_key(
    *,
    prefix: str,
    request_data: dict,
):
    fingerprint = hashlib.sha256(
        json.dumps(
            request_data,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    return f"{prefix}{fingerprint}"


def build_document_cache_key_from_sha(
    *,
    cache_version: str,
    user_id: str,
    pdf_sha256: str,
):
    return _build_cache_key(
        prefix=DOCUMENT_CACHE_PREFIX,
        request_data={
            "cache_version": cache_version,
            "user_id": user_id,
            "pdf_sha256": pdf_sha256,
        },
    )


def build_quiz_cache_key_from_sha(
    *,
    cache_version: str,
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
    return _build_cache_key(
        prefix=QUIZ_CACHE_PREFIX,
        request_data={
            "cache_version": cache_version,
            "user_id": user_id,
            "pdf_sha256": pdf_sha256,
            "content_type": content_type or "",
            "question_count": question_count,
            "difficulty": difficulty.strip().lower(),
            "question_type": question_type.strip().lower(),
            "focus_pages": focus_pages.strip(),
            "focus_question_types": focus_question_types.strip(),
            "avoid_questions": avoid_questions.strip(),
        },
    )
