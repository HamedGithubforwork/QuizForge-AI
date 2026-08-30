import hashlib
import json
import time

from redis_integration import (
    DOCUMENT_CACHE_MAX_BYTES,
    DOCUMENT_CACHE_TTL_SECONDS,
    DOCUMENT_CACHE_VERSION,
    QUIZ_CACHE_VERSION,
    get_cached_document,
)


_memory_documents: dict[
    str,
    tuple[float, dict],
] = {}


def normalize_document_sha256(
    value: str | None,
):
    normalized = (value or "").strip().lower()

    if len(normalized) != 64:
        return None

    if any(
        character not in "0123456789abcdef"
        for character in normalized
    ):
        return None

    return normalized


def build_document_cache_key_from_sha(
    *,
    user_id: str,
    pdf_sha256: str,
):
    request_data = {
        "cache_version": DOCUMENT_CACHE_VERSION,
        "user_id": user_id,
        "pdf_sha256": pdf_sha256,
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
    request_data = {
        "cache_version": QUIZ_CACHE_VERSION,
        "user_id": user_id,
        "pdf_sha256": pdf_sha256,
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


def _remove_expired_memory_documents():
    now = time.monotonic()

    expired_keys = [
        cache_key
        for cache_key, (
            expires_at,
            _document,
        ) in _memory_documents.items()
        if expires_at <= now
    ]

    for cache_key in expired_keys:
        _memory_documents.pop(
            cache_key,
            None,
        )


def remember_processed_document(
    *,
    user_id: str,
    pdf_sha256: str,
    pages: list,
):
    normalized_hash = (
        normalize_document_sha256(
            pdf_sha256
        )
    )

    if normalized_hash is None:
        return False

    document = {
        "pdf_sha256": normalized_hash,
        "pages": pages,
    }

    serialized_size = len(
        json.dumps(
            document,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    )

    if serialized_size > DOCUMENT_CACHE_MAX_BYTES:
        return False

    _remove_expired_memory_documents()

    cache_key = build_document_cache_key_from_sha(
        user_id=user_id,
        pdf_sha256=normalized_hash,
    )

    _memory_documents[cache_key] = (
        time.monotonic()
        + DOCUMENT_CACHE_TTL_SECONDS,
        document,
    )

    return True


async def get_processed_document(
    *,
    user_id: str,
    pdf_sha256: str,
):
    normalized_hash = (
        normalize_document_sha256(
            pdf_sha256
        )
    )

    if normalized_hash is None:
        return None

    cache_key = build_document_cache_key_from_sha(
        user_id=user_id,
        pdf_sha256=normalized_hash,
    )

    cached_document = await get_cached_document(
        cache_key
    )

    if cached_document is not None:
        return cached_document

    _remove_expired_memory_documents()

    memory_entry = _memory_documents.get(
        cache_key
    )

    if memory_entry is None:
        return None

    _expires_at, document = memory_entry
    return document
