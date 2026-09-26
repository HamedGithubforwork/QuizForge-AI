import asyncio
from io import BytesIO
from types import SimpleNamespace

from fastapi import HTTPException
from starlette.datastructures import Headers, UploadFile

import quiz_generation_support as support


def make_upload(contents=b"pdf-bytes"):
    return UploadFile(
        file=BytesIO(contents),
        filename="notes.pdf",
        headers=Headers(
            {
                "content-type": "application/pdf",
            }
        ),
    )


def test_generation_source_identity_accepts_processed_document_hash():
    value = asyncio.run(
        support.get_generation_source_identity(
            document_sha256="a" * 64,
            file=None,
        )
    )

    assert value == (
        "a" * 64,
        "application/pdf",
        None,
    )


def test_generation_source_identity_rejects_invalid_processed_hash():
    try:
        asyncio.run(
            support.get_generation_source_identity(
                document_sha256="not-a-hash",
                file=None,
            )
        )
    except HTTPException as error:
        assert error.status_code == 400
        assert (
            error.detail
            == "Processed document identifier is invalid."
        )
    else:
        raise AssertionError(
            "invalid processed document hash must be rejected"
        )


def test_generation_source_identity_reads_and_hashes_uploaded_pdf():
    contents = b"same pdf bytes"
    pdf_sha256, content_type, returned = asyncio.run(
        support.get_generation_source_identity(
            document_sha256="",
            file=make_upload(contents),
        )
    )

    assert pdf_sha256 == support.compute_pdf_sha256(
        contents
    )
    assert content_type == "application/pdf"
    assert returned == contents


def test_poll_delay_is_bounded(monkeypatch):
    observed = {}

    def fake_uniform(low, high):
        observed["bounds"] = (low, high)
        return high

    monkeypatch.setattr(
        support.random,
        "uniform",
        fake_uniform,
    )

    result = support.get_quiz_generation_poll_delay(
        4.0,
        maximum_interval_seconds=1.0,
        jitter_ratio=0.2,
    )

    assert result == 1.0
    assert observed["bounds"] == (
        0.8,
        1.0,
    )


def test_acquired_generation_turn_returns_token_without_waiting():
    async def try_lock(_cache_key):
        return SimpleNamespace(
            backend_available=True,
            acquired=True,
            token="token-1",
        )

    async def get_cached(_cache_key, _model):
        return None

    async def release(_cache_key, _token):
        raise AssertionError(
            "owned uncached turn must retain the lock token"
        )

    result = asyncio.run(
        support.acquire_quiz_generation_turn(
            "cache-key",
            use_cached_result=True,
            try_acquire_lock=try_lock,
            get_cached_quiz=get_cached,
            release_lock=release,
            quiz_model=object,
            wait_seconds=1,
            poll_interval_seconds=0.01,
            maximum_poll_interval_seconds=1,
            poll_delay_fn=lambda value: value,
        )
    )

    assert result == (
        None,
        "token-1",
    )


def test_acquired_turn_releases_lock_when_cache_is_already_filled():
    released = []

    async def try_lock(_cache_key):
        return SimpleNamespace(
            backend_available=True,
            acquired=True,
            token="token-2",
        )

    cached = object()

    async def get_cached(_cache_key, _model):
        return cached

    async def release(cache_key, token):
        released.append(
            (cache_key, token)
        )

    result = asyncio.run(
        support.acquire_quiz_generation_turn(
            "cache-key",
            use_cached_result=True,
            try_acquire_lock=try_lock,
            get_cached_quiz=get_cached,
            release_lock=release,
            quiz_model=object,
            wait_seconds=1,
            poll_interval_seconds=0.01,
            maximum_poll_interval_seconds=1,
            poll_delay_fn=lambda value: value,
        )
    )

    assert result == (
        cached,
        None,
    )
    assert released == [
        (
            "cache-key",
            "token-2",
        )
    ]
