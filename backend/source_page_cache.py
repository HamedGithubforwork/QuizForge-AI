import json
import logging
from typing import Any

from redis.exceptions import RedisError

from observability import log_event
from redis_integration import (
    DOCUMENT_CACHE_TTL_SECONDS,
    redis_client,
)


SOURCE_PAGE_CACHE_LAYOUT_VERSION = 1


def build_source_page_manifest_key(
    document_cache_key: str,
):
    return f"{document_cache_key}:source-pages"


def build_source_page_key(
    document_cache_key: str,
    page_number: int,
):
    return (
        f"{document_cache_key}:source-page:"
        f"{page_number}"
    )


def _valid_source_pages(pages: list):
    return [
        page
        for page in pages
        if (
            isinstance(page, dict)
            and isinstance(
                page.get("page_number"),
                int,
            )
            and page["page_number"] >= 1
            and isinstance(
                page.get("text"),
                str,
            )
        )
    ]


async def seed_source_page_cache(
    document_cache_key: str,
    pages: list,
    client: Any = None,
):
    selected_client = (
        client
        if client is not None
        else redis_client
    )

    if selected_client is None:
        return False

    source_pages = _valid_source_pages(
        pages
    )

    if not source_pages:
        return False

    page_numbers = [
        page["page_number"]
        for page in source_pages
    ]

    manifest = json.dumps(
        {
            "version": (
                SOURCE_PAGE_CACHE_LAYOUT_VERSION
            ),
            "page_numbers": page_numbers,
        },
        separators=(",", ":"),
    )

    try:
        pipeline_factory = getattr(
            selected_client,
            "pipeline",
            None,
        )

        if callable(pipeline_factory):
            pipeline = pipeline_factory(
                transaction=False
            )

            for page in source_pages:
                pipeline.set(
                    build_source_page_key(
                        document_cache_key,
                        page["page_number"],
                    ),
                    page["text"],
                    ex=(
                        DOCUMENT_CACHE_TTL_SECONDS
                    ),
                )

            # Write the manifest last so readers do not observe a
            # page list before the corresponding page values exist.
            pipeline.set(
                build_source_page_manifest_key(
                    document_cache_key
                ),
                manifest,
                ex=DOCUMENT_CACHE_TTL_SECONDS,
            )

            await pipeline.execute()
        else:
            for page in source_pages:
                await selected_client.set(
                    build_source_page_key(
                        document_cache_key,
                        page["page_number"],
                    ),
                    page["text"],
                    ex=(
                        DOCUMENT_CACHE_TTL_SECONDS
                    ),
                )

            await selected_client.set(
                build_source_page_manifest_key(
                    document_cache_key
                ),
                manifest,
                ex=DOCUMENT_CACHE_TTL_SECONDS,
            )
    except RedisError as error:
        log_event(
            "source_page_cache_backend_error",
            level=logging.WARNING,
            operation="write",
            error_type=type(error).__name__,
        )
        return False

    return True


def _parse_page_numbers(
    manifest_value: Any,
):
    if not isinstance(
        manifest_value,
        str,
    ):
        return None

    try:
        manifest = json.loads(
            manifest_value
        )
    except (
        TypeError,
        json.JSONDecodeError,
    ):
        return None

    if (
        not isinstance(manifest, dict)
        or manifest.get("version")
        != SOURCE_PAGE_CACHE_LAYOUT_VERSION
        or not isinstance(
            manifest.get("page_numbers"),
            list,
        )
    ):
        return None

    page_numbers = manifest[
        "page_numbers"
    ]

    if not all(
        isinstance(page_number, int)
        and page_number >= 1
        for page_number in page_numbers
    ):
        return None

    return page_numbers


async def get_cached_source_page(
    document_cache_key: str,
    page_number: int,
    client: Any = None,
):
    selected_client = (
        client
        if client is not None
        else redis_client
    )

    if selected_client is None:
        return "backend_unavailable", None

    manifest_key = (
        build_source_page_manifest_key(
            document_cache_key
        )
    )
    page_key = build_source_page_key(
        document_cache_key,
        page_number,
    )

    try:
        pipeline_factory = getattr(
            selected_client,
            "pipeline",
            None,
        )

        if callable(pipeline_factory):
            pipeline = pipeline_factory(
                transaction=False
            )
            pipeline.exists(
                document_cache_key
            )
            pipeline.get(manifest_key)
            pipeline.get(page_key)
            (
                document_exists,
                manifest_value,
                page_text,
            ) = await pipeline.execute()
        else:
            document_exists = (
                await selected_client.exists(
                    document_cache_key
                )
            )
            manifest_value = (
                await selected_client.get(
                    manifest_key
                )
            )
            page_text = await selected_client.get(
                page_key
            )
    except RedisError as error:
        log_event(
            "source_page_cache_backend_error",
            level=logging.WARNING,
            operation="read",
            error_type=type(error).__name__,
        )
        return "backend_unavailable", None

    if not document_exists:
        return "missing_document", None

    page_numbers = _parse_page_numbers(
        manifest_value
    )

    if page_numbers is None:
        return "unseeded", None

    if page_number not in page_numbers:
        return "missing_page", None

    if not isinstance(page_text, str):
        return "unseeded", None

    return "ok", page_text
