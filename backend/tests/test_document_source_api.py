import json

from fastapi.testclient import TestClient

import app_shared
import main
import processed_documents
from document_api import (
    UploadResponse,
    build_upload_response_from_sha,
)


DOCUMENT_SHA = "a" * 64
PAGES = [
    {
        "page_number": 1,
        "text": "Source page one text " * 250,
    },
    {
        "page_number": 2,
        "text": "Source page two text " * 250,
    },
]


def override_user(user_id: str):
    async def dependency():
        return app_shared.AuthenticatedUser(
            id=user_id,
            email=f"{user_id}@example.com",
        )

    return dependency


def test_upload_contract_omits_full_text_and_reduces_payload():
    legacy_full_text_shape = {
        "filename": "notes.pdf",
        "pdf_sha256": DOCUMENT_SHA,
        "pages": PAGES,
    }
    lightweight = UploadResponse.model_validate(
        build_upload_response_from_sha(
            filename="notes.pdf",
            pdf_sha256=DOCUMENT_SHA,
            pages=PAGES,
        )
    ).model_dump()

    assert all(
        "text" not in page
        for page in lightweight["pages"]
    )

    raw_size = len(
        json.dumps(
            legacy_full_text_shape
        ).encode("utf-8")
    )
    lightweight_size = len(
        json.dumps(lightweight).encode("utf-8")
    )

    assert lightweight_size < raw_size * 0.2


def test_source_page_endpoint_is_user_scoped():
    processed_documents._memory_documents.clear()

    processed_documents.remember_processed_document(
        user_id="user-1",
        pdf_sha256=DOCUMENT_SHA,
        pages=PAGES,
    )

    app = app_shared.create_app()
    app.dependency_overrides[
        app_shared.get_current_user
    ] = override_user("user-1")

    with TestClient(app) as client:
        response = client.get(
            f"/api/documents/{DOCUMENT_SHA}/pages/2"
        )

    assert response.status_code == 200
    assert response.json() == {
        "pdf_sha256": DOCUMENT_SHA,
        "page_number": 2,
        "text": PAGES[1]["text"],
    }

    app.dependency_overrides[
        app_shared.get_current_user
    ] = override_user("user-2")

    with TestClient(app) as client:
        cross_user_response = client.get(
            f"/api/documents/{DOCUMENT_SHA}/pages/2"
        )

    assert cross_user_response.status_code == 410
    assert (
        cross_user_response.json()["detail"]
        == "Processed document expired or is unavailable. Please process the PDF again."
    )

    processed_documents._memory_documents.clear()


def test_source_page_endpoint_rejects_invalid_or_missing_pages():
    processed_documents._memory_documents.clear()

    processed_documents.remember_processed_document(
        user_id="user-1",
        pdf_sha256=DOCUMENT_SHA,
        pages=PAGES,
    )

    app = app_shared.create_app()
    app.dependency_overrides[
        app_shared.get_current_user
    ] = override_user("user-1")

    with TestClient(app) as client:
        invalid_hash_response = client.get(
            "/api/documents/not-a-hash/pages/1"
        )
        missing_page_response = client.get(
            f"/api/documents/{DOCUMENT_SHA}/pages/99"
        )

    assert invalid_hash_response.status_code == 400
    assert missing_page_response.status_code == 404

    processed_documents._memory_documents.clear()


def test_upload_route_uses_lightweight_response_model():
    route = next(
        route
        for route in main.app.routes
        if getattr(route, "path", None)
        == "/api/documents/upload"
    )

    assert route.response_model is UploadResponse
