import logging
import time

import pymupdf
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from observability import log_event
from quiz_service import analyze_extracted_text, extract_pdf_pages


OCR_DPI = 150
OCR_LANGUAGE = "eng"
MIN_PAGE_TEXT_CHARACTERS = 20


def _page_has_raster_content(page):
    try:
        return bool(page.get_images(full=True))
    except Exception:
        return False


def _ocr_page_text(page):
    try:
        tessdata = pymupdf.get_tessdata()
        text_page = page.get_textpage_ocr(
            language=OCR_LANGUAGE,
            dpi=OCR_DPI,
            full=False,
            tessdata=tessdata,
        )
        return page.get_text(
            textpage=text_page,
        ).strip()
    except Exception as error:
        log_event(
            "pdf_ocr_error",
            level=logging.ERROR,
            error_type=type(error).__name__,
        )
        raise HTTPException(
            status_code=503,
            detail=(
                "OCR is temporarily unavailable for scanned PDFs. "
                "Please try again later."
            ),
        ) from error


def extract_pdf_pages_with_ocr(contents: bytes):
    """Extract selectable text, then OCR sparse raster pages when needed."""

    pages = extract_pdf_pages(contents)

    sparse_indexes = [
        index
        for index, page in enumerate(pages)
        if len(page["text"].strip()) < MIN_PAGE_TEXT_CHARACTERS
    ]

    if not sparse_indexes:
        return pages

    try:
        document = pymupdf.open(
            stream=contents,
            filetype="pdf",
        )
    except Exception:
        # The canonical extractor already validated the same bytes.
        return pages

    started_at = time.perf_counter()
    attempted_pages = 0
    improved_pages = 0

    try:
        for index in sparse_indexes:
            page = document[index]

            if not _page_has_raster_content(page):
                continue

            attempted_pages += 1
            existing_text = pages[index]["text"].strip()
            ocr_text = _ocr_page_text(page)

            if len(ocr_text) > len(existing_text):
                pages[index]["text"] = ocr_text
                improved_pages += 1
    finally:
        document.close()

    analysis = analyze_extracted_text(pages)

    if attempted_pages:
        log_event(
            "pdf_ocr_completed",
            attempted_page_count=attempted_pages,
            improved_page_count=improved_pages,
            page_count=len(pages),
            remaining_scanned_likely=(
                analysis["scanned_likely"]
            ),
            duration_ms=round(
                (time.perf_counter() - started_at) * 1000,
                3,
            ),
        )

    if analysis["scanned_likely"]:
        raise HTTPException(
            status_code=400,
            detail=(
                "Very little readable text could be extracted, even after OCR. "
                "Try a clearer scan or a text-based PDF."
            ),
        )

    return pages


async def extract_pdf_pages_off_event_loop(
    contents: bytes,
):
    return await run_in_threadpool(
        extract_pdf_pages_with_ocr,
        contents,
    )
