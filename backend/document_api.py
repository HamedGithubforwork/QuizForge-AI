from pydantic import BaseModel

from processed_documents import (
    get_processed_document,
    normalize_document_sha256,
)
from quiz_service import analyze_extracted_text


class UploadPageSummary(BaseModel):
    page_number: int
    character_count: int
    preview: str


class UploadResponse(BaseModel):
    filename: str | None
    pdf_sha256: str
    page_count: int
    character_count: int
    extractable_page_count: int
    scanned_likely: bool
    warning: str | None
    pages: list[UploadPageSummary]


class SourcePageResponse(BaseModel):
    pdf_sha256: str
    page_number: int
    text: str


def build_upload_response_from_sha(
    *,
    filename: str | None,
    pdf_sha256: str,
    pages: list,
):
    analysis = analyze_extracted_text(
        pages,
    )

    return {
        "filename": filename,
        "pdf_sha256": pdf_sha256,
        "page_count": len(pages),
        "character_count": analysis[
            "total_characters"
        ],
        "extractable_page_count": analysis[
            "extractable_page_count"
        ],
        "scanned_likely": analysis[
            "scanned_likely"
        ],
        "warning": analysis["warning"],
        "pages": [
            {
                "page_number": page["page_number"],
                "character_count": len(
                    page["text"]
                ),
                "preview": page["text"][:300],
            }
            for page in pages
        ],
    }


async def resolve_source_page(
    *,
    user_id: str,
    document_sha256: str,
    page_number: int,
):
    normalized_hash = normalize_document_sha256(
        document_sha256
    )

    if normalized_hash is None:
        return "invalid_document", None

    document = await get_processed_document(
        user_id=user_id,
        pdf_sha256=normalized_hash,
    )

    if document is None:
        return "missing_document", None

    source_page = next(
        (
            page
            for page in document["pages"]
            if page.get("page_number") == page_number
        ),
        None,
    )

    if source_page is None:
        return "missing_page", None

    source_text = source_page.get("text")

    if not isinstance(source_text, str):
        return "missing_page", None

    return (
        "ok",
        SourcePageResponse(
            pdf_sha256=normalized_hash,
            page_number=page_number,
            text=source_text,
        ),
    )
