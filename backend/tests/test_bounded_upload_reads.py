import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import application
import quiz_generation_support
import quiz_service


class FakeUpload:
    content_type = "application/pdf"
    filename = "notes.pdf"

    def __init__(self, payload_size=None):
        self.requested_read_sizes = []
        self.payload_size = payload_size

    async def read(self, size=-1):
        self.requested_read_sizes.append(size)
        return b"x" * (size if self.payload_size is None else self.payload_size)


def test_bounded_upload_reader_accepts_exact_size(monkeypatch):
    monkeypatch.setattr(quiz_service, "MAX_FILE_SIZE", 8)
    upload = FakeUpload(payload_size=8)

    contents = asyncio.run(quiz_service.read_pdf_upload(upload))

    assert len(contents) == 8
    assert upload.requested_read_sizes == [9]


@pytest.mark.parametrize("path", ["upload", "generation"])
def test_upload_paths_bound_reads_and_preserve_413(
    monkeypatch,
    path,
):
    # A small limit exercises the same max+1 behavior without allocating a
    # 15 MiB test payload.
    monkeypatch.setattr(quiz_service, "MAX_FILE_SIZE", 8)
    upload = FakeUpload()

    if path == "upload":
        operation = application.upload_pdf(
            file=upload,
            current_user=SimpleNamespace(id="test-user"),
        )
    else:
        operation = quiz_generation_support.get_generation_source_identity(
            document_sha256="",
            file=upload,
        )

    with pytest.raises(HTTPException) as error:
        asyncio.run(operation)

    assert upload.requested_read_sizes == [9]
    assert error.value.status_code == 413
    assert error.value.detail == (
        "PDF is too large. Maximum size is 15 MB."
    )
