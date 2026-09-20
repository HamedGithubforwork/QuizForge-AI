"""Verify the production image can OCR an image-only PDF with Tesseract."""

import sys
import asyncio
from collections import Counter
import re
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import pymupdf

from pdf_ocr import extract_pdf_pages_with_ocr
from pdf_process import extract_in_process, extract_background


EXPECTED_WORDS = {
    "quizforge",
    "scanned",
    "ocr",
    "verification",
    "7391",
}

OCR_FIXTURE_TEXT = (
    "QuizForge scanned OCR verification 7391. "
    "This image-only study page contains enough repeated readable text to "
    "clear the application's minimum study-material threshold after OCR. "
    "QuizForge scanned OCR verification 7391."
)


def build_scanned_pdf():
    source = pymupdf.open()
    target = pymupdf.open()

    try:
        source_page = source.new_page()
        source_page.insert_textbox(
            pymupdf.Rect(72, 72, 540, 500),
            OCR_FIXTURE_TEXT,
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


def main():
    pages = extract_pdf_pages_with_ocr(
        build_scanned_pdf()
    )
    recognized = " ".join(
        page["text"]
        for page in pages
    ).lower()

    missing = {
        word
        for word in EXPECTED_WORDS
        if word not in recognized
    }

    if missing:
        raise SystemExit(
            "OCR runtime verification failed; missing expected tokens: "
            + ", ".join(sorted(missing))
        )

    if len(recognized) < 100:
        raise SystemExit(
            "OCR runtime verification failed; recognized text was too short."
        )

    # This path is required even if a CI runner lacks system Tesseract: the
    # production Docker image must exercise the actual isolated native engine.
    asyncio.run(verify_isolated_quality())

    print("OCR runtime verification passed.")


def quality_fixture():
    expected = []
    lesson = (
        'Photosynthesis converts sunlight into chemical energy. Chlorophyll absorbs light. '
        'Plants use water and carbon dioxide to produce glucose and oxygen. '
        'Mitochondria release stored energy through cellular respiration. '
        'A balanced ecosystem includes producers, consumers, and decomposers. '
    )
    with pymupdf.open() as source, pymupdf.open() as target:
        for index in range(4):
            page = source.new_page(width=595, height=842)
            text = lesson * 3
            if index == 1:
                for rect in (pymupdf.Rect(40, 40, 282, 800), pymupdf.Rect(312, 40, 555, 800)):
                    assert page.insert_textbox(rect, text, fontsize=10) >= 0
                text *= 2
            else:
                assert page.insert_textbox(pymupdf.Rect(40, 40, 555, 800), text,
                                           fontsize=9 if index == 0 else 12) >= 0
            matrix = pymupdf.Matrix(150 / 72, 150 / 72)
            if index == 3:
                matrix = matrix.prerotate(90)
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            output = target.new_page(width=842 if index == 3 else 595, height=595 if index == 3 else 842)
            output.insert_image(output.rect, stream=pixmap.tobytes('jpeg', jpg_quality=80))
            if index == 2:
                output.insert_text((40, 30), 'Notes')  # Sparse selectable text plus scan.
                text = 'Notes ' + text
            if index == 3:
                output.set_rotation(270)  # A scan made upright by PDF rotation metadata.
            expected.append(text)
        return target.tobytes(), expected


async def verify_isolated_quality():
    raw, expected = quality_fixture()
    pages = await extract_in_process(raw)
    assert len(pages) == len(expected)
    for page, original in zip(pages, expected):
        reference = Counter(re.findall(r'[a-z0-9]+', original.lower()))
        recognized = Counter(re.findall(r'[a-z0-9]+', page['text'].lower()))
        overlap = sum((reference & recognized).values())
        assert overlap / sum(reference.values()) >= .95, 'Isolated OCR lost study text'
        assert overlap / sum(recognized.values()) >= .95, 'Isolated OCR added unexpected text'
    checkpoints = []
    async def save(batch, total):
        checkpoints.extend(batch)
        assert total == len(expected)
        raise asyncio.CancelledError()
    try:
        await extract_background(raw, on_checkpoint=save)
    except asyncio.CancelledError:
        pass
    assert len(checkpoints) == 1
    resumed = []
    async def observe(batch, total): resumed.extend(page['page_number'] for page in batch)
    restored = await extract_background(raw, checkpoint=checkpoints, on_checkpoint=observe)
    assert resumed == [2, 3, 4] and restored == pages


if __name__ == "__main__":
    main()
