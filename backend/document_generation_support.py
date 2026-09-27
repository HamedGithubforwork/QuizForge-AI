"""Document cache and processed-page resolution for quiz generation."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import HTTPException


async def get_document_pages_with_cache(
    *,
    user_id: str,
    contents: bytes,
    pdf_sha256: str | None,
    compute_hash: Callable[[bytes], str],
    build_cache_key: Callable[..., str],
    get_cached_document: Callable[[str], Awaitable[Any]],
    extract_pages: Callable[[bytes], Awaitable[Any]],
    cache_document: Callable[[str, Any], Awaitable[bool]],
    forget_processed_document: Callable[..., Any],
    remember_processed_document: Callable[..., bool],
    record_cache_metric: Callable[..., Awaitable[Any]],
    redis_client: Any,
    log_event: Callable[..., Any],
):
    resolved_pdf_sha256 = (
        pdf_sha256
        if pdf_sha256 is not None
        else compute_hash(contents)
    )

    cache_key = build_cache_key(
        user_id=user_id,
        pdf_sha256=resolved_pdf_sha256,
    )

    cached_document = await get_cached_document(
        cache_key
    )

    if cached_document is not None:
        forget_processed_document(
            user_id=user_id,
            pdf_sha256=resolved_pdf_sha256,
        )

        await record_cache_metric(
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
            resolved_pdf_sha256,
            cached_document["pages"],
        )

    pages = await extract_pages(
        contents
    )

    cached = await cache_document(
        cache_key,
        {
            "pdf_sha256": resolved_pdf_sha256,
            "pages": pages,
        },
    )

    fallback_stored = False

    if cached:
        forget_processed_document(
            user_id=user_id,
            pdf_sha256=resolved_pdf_sha256,
        )
    else:
        fallback_stored = remember_processed_document(
            user_id=user_id,
            pdf_sha256=resolved_pdf_sha256,
            pages=pages,
        )

    await record_cache_metric(
        redis_client,
        "miss",
    )

    log_event(
        "document_cache_lookup",
        cache_result="miss",
        page_count=len(pages),
        stored=cached,
        fallback_stored=fallback_stored,
    )

    return resolved_pdf_sha256, pages


async def get_generation_pages(
    *,
    user_id: str,
    pdf_sha256: str,
    contents: bytes | None,
    get_document_pages_with_cache: Callable[..., Awaitable[Any]],
    get_processed_document: Callable[..., Awaitable[Any]],
    record_cache_metric: Callable[..., Awaitable[Any]],
    redis_client: Any,
    log_event: Callable[..., Any],
):
    if contents is not None:
        _resolved_hash, pages = (
            await get_document_pages_with_cache(
                user_id=user_id,
                contents=contents,
                pdf_sha256=pdf_sha256,
            )
        )

        return pages

    document = await get_processed_document(
        user_id=user_id,
        pdf_sha256=pdf_sha256,
    )

    if document is None:
        await record_cache_metric(
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

    await record_cache_metric(
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

    return document["pages"]
