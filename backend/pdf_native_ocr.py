"""Tesseract 5 C API, used only inside the resource-limited Linux PDF child.

One engine per document avoids repeated model initialization and the searchable
PDF encode/decode round trip. Never share the handle across threads/documents.
C signatures: https://github.com/tesseract-ocr/tesseract/blob/5.5.0/include/tesseract/capi.h
"""
import ctypes as c

import pymupdf

OCR_DPI = 150
MAX_PAGE_PIXELS = 12_000_000


class OcrEngine:
    def __init__(self, *, colorspace=None):
        self.colorspace = pymupdf.csGRAY if colorspace is None else colorspace
        self.handle = None
        self.lib = c.CDLL('libtesseract.so.5')
        signatures = (
            ('TessBaseAPICreate', [], c.c_void_p),
            ('TessBaseAPIDelete', [c.c_void_p], None),
            ('TessBaseAPIInit3', [c.c_void_p, c.c_char_p, c.c_char_p], c.c_int),
            ('TessBaseAPISetImage', [c.c_void_p, c.c_char_p, c.c_int, c.c_int, c.c_int, c.c_int], None),
            ('TessBaseAPISetSourceResolution', [c.c_void_p, c.c_int], None),
            ('TessBaseAPISetPageSegMode', [c.c_void_p, c.c_int], None),
            ('TessBaseAPIGetUTF8Text', [c.c_void_p], c.c_void_p),
            ('TessDeleteText', [c.c_void_p], None),
            ('TessBaseAPIClear', [c.c_void_p], None),
            ('TessBaseAPIClearAdaptiveClassifier', [c.c_void_p], None),
        )
        for name, args, result in signatures:
            function = getattr(self.lib, name)
            function.argtypes, function.restype = args, result
        self.handle = self.lib.TessBaseAPICreate()
        if not self.handle:
            raise RuntimeError('Could not allocate OCR engine')
        try:
            if self.lib.TessBaseAPIInit3(self.handle, pymupdf.get_tessdata().encode(), b'eng') != 0:
                raise RuntimeError('Could not initialize OCR engine')
            self.lib.TessBaseAPISetPageSegMode(self.handle, 3)  # Automatic page layout.
        except BaseException:
            self.close()
            raise

    def text(self, page):
        # Bound rounded raster dimensions before allocating a pixmap.
        import math
        if math.ceil(page.rect.width * OCR_DPI / 72) * math.ceil(page.rect.height * OCR_DPI / 72) > MAX_PAGE_PIXELS:
            raise ValueError('OCR page is too large')
        pixmap = page.get_pixmap(dpi=OCR_DPI, colorspace=self.colorspace, alpha=False)
        samples = pixmap.samples  # Keep the buffer alive until recognition ends.
        pointer = None
        try:
            self.lib.TessBaseAPISetImage(self.handle, samples, pixmap.width, pixmap.height, pixmap.n, pixmap.stride)
            self.lib.TessBaseAPISetSourceResolution(self.handle, OCR_DPI)
            pointer = self.lib.TessBaseAPIGetUTF8Text(self.handle)
            if not pointer:
                raise RuntimeError('OCR recognition failed')
            return c.string_at(pointer).decode('utf-8').strip()
        finally:
            if pointer:
                self.lib.TessDeleteText(pointer)
            self.lib.TessBaseAPIClear(self.handle)
            self.lib.TessBaseAPIClearAdaptiveClassifier(self.handle)

    def close(self):
        if self.handle:
            self.lib.TessBaseAPIDelete(self.handle)
            self.handle = None
