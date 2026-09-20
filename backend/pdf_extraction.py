"""Bounded extraction used by pdf_worker; no API/database/model imports."""
import math

import pymupdf

from pdf_native_ocr import MAX_PAGE_PIXELS, OCR_DPI, OcrEngine
from pdf_protocol import encode_pages, validate_pages
from pdf_text import analyze_extracted_text


class PdfError(Exception):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail
        super().__init__(detail)


def extract(contents, *, checkpoint=None, on_pages=None):
    try:
        document = pymupdf.open(stream=contents, filetype='pdf')
    except Exception:
        raise PdfError(400, 'Could not read this PDF.') from None
    with document:
        if document.needs_pass:
            raise PdfError(400, 'Password-protected PDFs are not supported yet.')
        if document.page_count > 100:
            raise PdfError(413, 'This server accepts PDFs with up to 100 pages.')
        pages, scanned = [], set()
        for index, page in enumerate(document):
            if math.ceil(page.rect.width * OCR_DPI / 72) * math.ceil(page.rect.height * OCR_DPI / 72) > MAX_PAGE_PIXELS:
                raise PdfError(413, 'A PDF page is too large. Resize it before uploading.')
            text = page.get_text().strip()
            pages.append({'page_number': index + 1, 'text': text})
            if len(text) < 20 and page.get_images(full=True):
                scanned.add(index)
        if len(scanned) > 30:
            raise PdfError(413, 'This server accepts up to 30 scanned pages per PDF.')
        checkpoint = [] if checkpoint is None else checkpoint
        validate_pages(checkpoint, total=len(pages))
        pages[:len(checkpoint)] = checkpoint
        engine = None
        pending = []
        try:
            for index in range(len(checkpoint), len(pages)):
                if index in scanned:
                    try:
                        if engine is None:
                            engine = OcrEngine()
                        text = engine.text(document[index])
                    except Exception:
                        raise PdfError(503, 'OCR is temporarily unavailable for scanned PDFs. Please try again later.') from None
                    if len(text) > len(pages[index]['text']):
                        pages[index]['text'] = text
                pending.append(pages[index])
                if index in scanned or index == len(pages) - 1:
                    try:
                        encode_pages(pages)
                    except ValueError:
                        raise PdfError(413, 'Extracted document text is too large.') from None
                    if on_pages:
                        on_pages(pending, len(pages))
                    pending = []
        finally:
            if engine is not None:
                engine.close()
        # Preserve the legacy sparse/blank page readability check.
        if any(len(page['text'].strip()) < 20 for page in pages) or scanned:
            if analyze_extracted_text(pages)['scanned_likely']:
                raise PdfError(400, 'Very little readable text could be extracted, even after OCR. Try a clearer scan or a text-based PDF.')
        return pages
