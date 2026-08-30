import asyncio
import hashlib
from io import BytesIO

import pymupdf
from fastapi import UploadFile
from starlette.datastructures import Headers

import main


def make_pdf_bytes() -> bytes:
    document = pymupdf.open()

    try:
        page = document.new_page()
        page.insert_textbox(
            pymupdf.Rect(
                72,
                72,
                540,
                500,
            ),
            (
                "Stable document identity test PDF. "
                "The contents stay identical even when "
                "the uploaded filename changes."
            ),
        )
        return document.tobytes()
    finally:
        document.close()


def make_upload(
    filename: str,
    contents: bytes,
):
    return UploadFile(
        file=BytesIO(contents),
        filename=filename,
        headers=Headers(
            {
                "content-type":
                    "application/pdf",
            }
        ),
    )


def test_upload_hash_is_stable_when_filename_changes():
    contents = make_pdf_bytes()
    user = main.AuthenticatedUser(
        id="document-identity-test-user",
    )

    first = asyncio.run(
        main.upload_pdf(
            file=make_upload(
                "notes.pdf",
                contents,
            ),
            current_user=user,
        )
    )

    second = asyncio.run(
        main.upload_pdf(
            file=make_upload(
                "renamed-notes.pdf",
                contents,
            ),
            current_user=user,
        )
    )

    expected_hash = hashlib.sha256(
        contents
    ).hexdigest()

    assert first["filename"] == "notes.pdf"
    assert second["filename"] == (
        "renamed-notes.pdf"
    )
    assert first["pdf_sha256"] == expected_hash
    assert second["pdf_sha256"] == expected_hash
    assert len(first["pdf_sha256"]) == 64
