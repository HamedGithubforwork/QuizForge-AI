import json
import time
from collections import OrderedDict

from cache_identity import normalize_document_sha256
from redis_integration import (
    DOCUMENT_CACHE_MAX_BYTES,
    DOCUMENT_CACHE_TTL_SECONDS,
    build_document_cache_key_from_sha,
    build_quiz_cache_key_from_sha,
    get_cached_document,
    get_positive_int_env,
)


PROCESSED_DOCUMENT_MEMORY_MAX_ENTRIES = get_positive_int_env(
    "PROCESSED_DOCUMENT_MEMORY_MAX_ENTRIES",
    16,
)

PROCESSED_DOCUMENT_MEMORY_MAX_BYTES = get_positive_int_env(
    "PROCESSED_DOCUMENT_MEMORY_MAX_BYTES",
    12_000_000,
)


_memory_documents: OrderedDict[
    str,
    tuple[float, int, dict],
] = OrderedDict()


def _remove_expired_memory_documents(
    now: float | None = None,
):
    resolved_now = (
        time.monotonic()
        if now is None
        else now
    )

    expired_keys = [
        cache_key
        for cache_key, (
            expires_at,
            _serialized_size,
            _document,
        ) in _memory_documents.items()
        if expires_at <= resolved_now
    ]

    for cache_key in expired_keys:
        _memory_documents.pop(
            cache_key,
            None,
        )


def _memory_document_bytes():
    return sum(
        serialized_size
        for (
            _expires_at,
            serialized_size,
            _document,
        ) in _memory_documents.values()
    )


def forget_processed_document(
    *,
    user_id: str,
    pdf_sha256: str,
):
    normalized_hash = normalize_document_sha256(
        pdf_sha256
    )

    if normalized_hash is None:
        return False

    cache_key = build_document_cache_key_from_sha(
        user_id=user_id,
        pdf_sha256=normalized_hash,
    )

    return (
        _memory_documents.pop(
            cache_key,
            None,
        )
        is not None
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

    if (
        serialized_size > DOCUMENT_CACHE_MAX_BYTES
        or serialized_size
        > PROCESSED_DOCUMENT_MEMORY_MAX_BYTES
    ):
        return False

    now = time.monotonic()
    _remove_expired_memory_documents(now)

    cache_key = build_document_cache_key_from_sha(
        user_id=user_id,
        pdf_sha256=normalized_hash,
    )

    _memory_documents.pop(
        cache_key,
        None,
    )

    while (
        _memory_documents
        and (
            len(_memory_documents)
            >= PROCESSED_DOCUMENT_MEMORY_MAX_ENTRIES
            or (
                _memory_document_bytes()
                + serialized_size
                > PROCESSED_DOCUMENT_MEMORY_MAX_BYTES
            )
        )
    ):
        _memory_documents.popitem(
            last=False
        )

    if (
        len(_memory_documents)
        >= PROCESSED_DOCUMENT_MEMORY_MAX_ENTRIES
        or (
            _memory_document_bytes()
            + serialized_size
            > PROCESSED_DOCUMENT_MEMORY_MAX_BYTES
        )
    ):
        return False

    _memory_documents[cache_key] = (
        now + DOCUMENT_CACHE_TTL_SECONDS,
        serialized_size,
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
        _memory_documents.pop(
            cache_key,
            None,
        )
        return cached_document

    _remove_expired_memory_documents()

    memory_entry = _memory_documents.get(
        cache_key
    )

    if memory_entry is None:
        return None

    (
        _expires_at,
        _serialized_size,
        document,
    ) = memory_entry

    _memory_documents.move_to_end(
        cache_key
    )

    return document
