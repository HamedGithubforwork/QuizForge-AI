"""Verify the production image can OCR an image-only PDF with Tesseract."""

import pymupdf

from pdf_ocr import extract_pdf_pages_with_ocr


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

    print("OCR runtime verification passed.")


if __name__ == "__main__":
    main()
