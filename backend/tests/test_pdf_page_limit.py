import asyncio

import pymupdf
import pytest
from fastapi import HTTPException

import document_generation_support
import document_api
import quiz_service


def make_pdf(page_count: int, *, encrypted: bool = False) -> bytes:
    document = pymupdf.open()

    try:
        for _ in range(page_count):
            document.new_page()

        options = {}
        if encrypted:
            options = {
                "encryption": pymupdf.PDF_ENCRYPT_AES_256,
                "owner_pw": "owner-password",
                "user_pw": "user-password",
            }

        return document.tobytes(**options)
    finally:
        document.close()


@pytest.mark.parametrize("page_count", [99, 100])
def test_pdf_page_limit_accepts_supported_boundary(page_count):
    pages = quiz_service.extract_pdf_pages(make_pdf(page_count))

    assert len(pages) == page_count
    assert pages[0]["page_number"] == 1
    assert pages[-1]["page_number"] == page_count


@pytest.mark.parametrize("page_count", [101, 199, 200, 201])
def test_pdf_page_limit_rejects_before_page_text_extraction(
    page_count,
    monkeypatch,
):
    contents = make_pdf(page_count)
    original_open = pymupdf.open
    opened_documents = []

    class NoIterationDocument:
        def __init__(self, document):
            self.document = document
            self.needs_pass = document.needs_pass
            self.page_count = document.page_count
            self.closed = False

        def __iter__(self):
            raise AssertionError(
                "page text extraction must not start for an oversized PDF"
            )

        def close(self):
            self.closed = True
            self.document.close()

    def tracked_open(**kwargs):
        document = NoIterationDocument(original_open(**kwargs))
        opened_documents.append(document)
        return document

    monkeypatch.setattr(pymupdf, "open", tracked_open)

    with pytest.raises(HTTPException) as error:
        quiz_service.extract_pdf_pages(contents)

    assert error.value.status_code == 413
    assert error.value.detail == (
        "PDF contains too many pages. Maximum is 100 pages."
    )
    assert len(opened_documents) == 1
    assert opened_documents[0].closed is True


def test_malformed_pdf_keeps_clear_client_error():
    with pytest.raises(HTTPException) as error:
        quiz_service.extract_pdf_pages(b"not a PDF")

    assert error.value.status_code == 400
    assert error.value.detail == "Could not read this PDF."


def test_password_protected_pdf_keeps_existing_error():
    with pytest.raises(HTTPException) as error:
        quiz_service.extract_pdf_pages(make_pdf(1, encrypted=True))

    assert error.value.status_code == 400
    assert error.value.detail == (
        "Password-protected PDFs are not supported yet."
    )


def test_upload_response_is_bounded_by_supported_page_limit():
    pages = [
        {"page_number": index, "text": "x" * 10_000}
        for index in range(1, 101)
    ]

    response = document_api.build_upload_response_from_sha(
        filename="notes.pdf",
        pdf_sha256="a" * 64,
        pages=pages,
    )

    assert response["page_count"] == 100
    assert len(response["pages"]) == 100
    assert all(len(page["preview"]) <= 300 for page in response["pages"])
    assert sum(len(page["preview"]) for page in response["pages"]) <= 30_000


def _cache_pipeline_callbacks(*, cached_document=None, extract_pages=None):
    calls = {"cache": [], "forget": [], "remember": [], "metrics": []}

    async def get_cached_document(_key):
        return cached_document

    async def cache_document(key, document):
        calls["cache"].append((key, document))
        return True

    def forget_processed_document(**kwargs):
        calls["forget"].append(kwargs)

    def remember_processed_document(**kwargs):
        calls["remember"].append(kwargs)
        return True

    async def record_cache_metric(_client, result):
        calls["metrics"].append(result)

    async def default_extract(contents):
        return quiz_service.extract_pdf_pages(contents)

    return calls, {
        "user_id": "user-1",
        "contents": make_pdf(101),
        "pdf_sha256": None,
        "compute_hash": lambda contents: "f" * 64,
        "build_cache_key": lambda **kwargs: "document-cache-key",
        "get_cached_document": get_cached_document,
        "extract_pages": extract_pages or default_extract,
        "validate_pages": quiz_service.validate_extracted_pdf_pages,
        "cache_document": cache_document,
        "forget_processed_document": forget_processed_document,
        "remember_processed_document": remember_processed_document,
        "record_cache_metric": record_cache_metric,
        "redis_client": object(),
        "log_event": lambda *_args, **_kwargs: None,
    }


def test_rejected_pdf_is_not_partially_cached_or_remembered():
    calls, kwargs = _cache_pipeline_callbacks()

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            document_generation_support.get_document_pages_with_cache(
                **kwargs
            )
        )

    assert error.value.status_code == 413
    assert calls["cache"] == []
    assert calls["remember"] == []
    assert calls["forget"] == []


def test_stale_oversized_cache_is_rejected_before_processing():
    oversized_pages = [
        {"page_number": index, "text": "stale"}
        for index in range(1, 102)
    ]
    calls, kwargs = _cache_pipeline_callbacks(
        cached_document={"pages": oversized_pages}
    )

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            document_generation_support.get_document_pages_with_cache(
                **kwargs
            )
        )

    assert error.value.status_code == 413
    assert calls["cache"] == []
    assert calls["remember"] == []
    assert calls["forget"] == []
    assert calls["metrics"] == []


def test_stale_oversized_processed_document_is_rejected():
    oversized_pages = [
        {"page_number": index, "text": "stale"}
        for index in range(1, 102)
    ]
    metric_calls = []

    async def get_processed_document(**_kwargs):
        return {"pages": oversized_pages}

    async def record_metric(_client, result):
        metric_calls.append(result)

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            document_generation_support.get_generation_pages(
                user_id="user-1",
                pdf_sha256="f" * 64,
                contents=None,
                get_document_pages_with_cache=lambda **_kwargs: None,
                get_processed_document=get_processed_document,
                validate_pages=quiz_service.validate_extracted_pdf_pages,
                record_cache_metric=record_metric,
                redis_client=object(),
                log_event=lambda *_args, **_kwargs: None,
            )
        )

    assert error.value.status_code == 413
    assert metric_calls == []
