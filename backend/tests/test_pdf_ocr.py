import pymupdf
import pytest
from fastapi import HTTPException

import pdf_ocr


TEXT_DOCUMENT = (
    "QuizForge text extraction fast path. "
    "This sentence is repeated to ensure the document has enough selectable "
    "text to avoid OCR entirely. "
) * 2

OCR_DOCUMENT = (
    "QuizForge scanned document OCR verification. "
    "Recovered text should be long enough to support quiz generation. "
) * 2


def make_text_pdf(text: str = TEXT_DOCUMENT):
    document = pymupdf.open()

    try:
        page = document.new_page()
        page.insert_textbox(
            pymupdf.Rect(72, 72, 540, 500),
            text,
            fontsize=12,
        )
        return document.tobytes()
    finally:
        document.close()


def make_raster_pdf(text: str = OCR_DOCUMENT):
    source = pymupdf.open()
    target = pymupdf.open()

    try:
        source_page = source.new_page()
        source_page.insert_textbox(
            pymupdf.Rect(72, 72, 540, 500),
            text,
            fontsize=20,
        )
        pixmap = source_page.get_pixmap(
            matrix=pymupdf.Matrix(2, 2),
            alpha=False,
        )

        target_page = target.new_page(
            width=source_page.rect.width,
            height=source_page.rect.height,
        )
        target_page.insert_image(
            target_page.rect,
            stream=pixmap.tobytes("png"),
        )

        return target.tobytes()
    finally:
        source.close()
        target.close()


def test_text_pdf_keeps_selectable_text_fast_path(
    monkeypatch,
):
    def fail_if_called(_page):
        raise AssertionError(
            "text PDFs must not invoke OCR"
        )

    monkeypatch.setattr(
        pdf_ocr,
        "_ocr_page_text",
        fail_if_called,
    )

    pages = pdf_ocr.extract_pdf_pages_with_ocr(
        make_text_pdf()
    )

    assert len(pages) == 1
    assert "QuizForge text extraction" in pages[0]["text"]


def test_raster_pdf_uses_ocr_for_sparse_page(
    monkeypatch,
):
    monkeypatch.setattr(
        pdf_ocr,
        "_ocr_page_text",
        lambda _page: OCR_DOCUMENT,
    )

    pages = pdf_ocr.extract_pdf_pages_with_ocr(
        make_raster_pdf()
    )

    assert len(pages) == 1
    assert pages[0]["text"] == OCR_DOCUMENT
    assert (
        pdf_ocr.analyze_extracted_text(pages)[
            "scanned_likely"
        ]
        is False
    )


def test_unreadable_scan_returns_clear_error(
    monkeypatch,
):
    monkeypatch.setattr(
        pdf_ocr,
        "_ocr_page_text",
        lambda _page: "",
    )

    with pytest.raises(HTTPException) as error:
        pdf_ocr.extract_pdf_pages_with_ocr(
            make_raster_pdf()
        )

    assert error.value.status_code == 400
    assert "even after OCR" in error.value.detail


def test_missing_ocr_runtime_fails_closed(
    monkeypatch,
):
    document = pymupdf.open(
        stream=make_raster_pdf(),
        filetype="pdf",
    )

    def fail_tessdata():
        raise RuntimeError("tessdata missing")

    monkeypatch.setattr(
        pymupdf,
        "get_tessdata",
        fail_tessdata,
    )

    try:
        with pytest.raises(HTTPException) as error:
            pdf_ocr._ocr_page_text(document[0])
    finally:
        document.close()

    assert error.value.status_code == 503
    assert error.value.detail == (
        "OCR is temporarily unavailable for scanned PDFs. "
        "Please try again later."
    )
