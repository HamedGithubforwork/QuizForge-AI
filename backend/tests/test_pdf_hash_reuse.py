import asyncio
import hashlib
from io import BytesIO

from starlette.datastructures import Headers, UploadFile

import main_redis
from processed_documents import (
    build_document_cache_key_from_sha,
)
from redis_integration import (
    build_document_cache_key,
    compute_pdf_sha256,
)


CONTENTS = b"%PDF-1.4\nQuizForge hash reuse fixture\n"
PAGES = [
    {
        "page_number": 1,
        "text": (
            "QuizForge test material with enough "
            "selectable text for upload metadata."
        ),
    }
]


def make_upload():
    return UploadFile(
        file=BytesIO(CONTENTS),
        filename="notes.pdf",
        headers=Headers(
            {
                "content-type": "application/pdf",
            }
        ),
    )


def patch_document_cache_dependencies(
    monkeypatch,
):
    stored_documents = []

    async def fake_get_cached_document(
        _cache_key,
    ):
        return None

    async def fake_extraction(received_contents):
        assert received_contents == CONTENTS
        return PAGES

    async def fake_cache_document(
        cache_key,
        document,
    ):
        stored_documents.append(
            (cache_key, document)
        )
        return True

    async def fake_metric(
        _client,
        _cache_result,
    ):
        return None

    monkeypatch.setattr(
        main_redis,
        "get_cached_document",
        fake_get_cached_document,
    )
    monkeypatch.setattr(
        main_redis,
        "extract_pdf_pages_off_event_loop",
        fake_extraction,
    )
    monkeypatch.setattr(
        main_redis,
        "cache_document",
        fake_cache_document,
    )
    monkeypatch.setattr(
        main_redis,
        "record_document_cache_metric",
        fake_metric,
    )

    return stored_documents


def install_hash_counter(monkeypatch):
    calls = []

    def counted_hash(contents):
        calls.append(contents)
        return hashlib.sha256(
            contents
        ).hexdigest()

    monkeypatch.setattr(
        main_redis,
        "compute_pdf_sha256",
        counted_hash,
    )

    return calls


def test_precomputed_hash_keeps_existing_document_cache_key():
    pdf_sha256 = compute_pdf_sha256(
        CONTENTS
    )

    assert build_document_cache_key(
        user_id="user-1",
        contents=CONTENTS,
    ) == build_document_cache_key_from_sha(
        user_id="user-1",
        pdf_sha256=pdf_sha256,
    )


def test_document_cache_reuses_precomputed_hash(
    monkeypatch,
):
    stored_documents = (
        patch_document_cache_dependencies(
            monkeypatch
        )
    )
    hash_calls = install_hash_counter(
        monkeypatch
    )
    pdf_sha256 = hashlib.sha256(
        CONTENTS
    ).hexdigest()

    result_hash, result_pages = asyncio.run(
        main_redis.get_document_pages_with_cache(
            user_id="user-1",
            contents=CONTENTS,
            pdf_sha256=pdf_sha256,
        )
    )

    assert hash_calls == []
    assert result_hash == pdf_sha256
    assert result_pages == PAGES
    assert stored_documents[0][1] == {
        "pdf_sha256": pdf_sha256,
        "pages": PAGES,
    }


def test_legacy_file_generation_hashes_pdf_once(
    monkeypatch,
):
    patch_document_cache_dependencies(
        monkeypatch
    )
    hash_calls = install_hash_counter(
        monkeypatch
    )
    monkeypatch.setattr(
        main_redis,
        "remember_processed_document",
        lambda **_kwargs: True,
    )

    async def scenario():
        (
            pdf_sha256,
            _content_type,
            contents,
        ) = await main_redis.get_generation_source_identity(
            document_sha256="",
            file=make_upload(),
        )

        pages = await main_redis.get_generation_pages(
            user_id="user-1",
            pdf_sha256=pdf_sha256,
            contents=contents,
        )

        return pdf_sha256, pages

    pdf_sha256, pages = asyncio.run(
        scenario()
    )

    assert hash_calls == [CONTENTS]
    assert pdf_sha256 == hashlib.sha256(
        CONTENTS
    ).hexdigest()
    assert pages == PAGES


def test_production_upload_hashes_pdf_once(
    monkeypatch,
):
    patch_document_cache_dependencies(
        monkeypatch
    )
    hash_calls = install_hash_counter(
        monkeypatch
    )
    monkeypatch.setattr(
        main_redis,
        "remember_processed_document",
        lambda **_kwargs: True,
    )

    response = asyncio.run(
        main_redis.upload_pdf(
            file=make_upload(),
            current_user=(
                main_redis.AuthenticatedUser(
                    id="user-1"
                )
            ),
        )
    )

    expected_hash = hashlib.sha256(
        CONTENTS
    ).hexdigest()

    assert hash_calls == [CONTENTS]
    assert response["pdf_sha256"] == expected_hash
    assert response["pages"] == [
        {
            "page_number": 1,
            "character_count": len(
                PAGES[0]["text"]
            ),
            "preview": PAGES[0]["text"][:300],
        }
    ]
