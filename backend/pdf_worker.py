"""Single-document subprocess protocol. No database or model credentials needed."""
import json
import os
import resource
import sys

MAX_RESULT_BYTES = 8 * 1024 * 1024


def main():
    import ctypes
    import signal
    parent = os.getenv('PDF_WORKER_PARENT_PID')
    if parent:
        if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != int(parent):
            return
    # Reserve stdout exclusively for the protocol, including when native PDF/OCR
    # libraries print diagnostics directly to file descriptor 1.
    result_fd = os.dup(1)
    os.dup2(2, 1)
    progress_mode = '--progress' in sys.argv
    protocol = os.fdopen(result_fd, 'wb')

    def progress(completed, total):
        protocol.write(json.dumps({'type': 'progress', 'completed': completed, 'total': total}).encode() + b'\n')
        protocol.flush()

    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024**2, 768 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (90, 95))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    try:
        from fastapi import HTTPException
        import pymupdf
        from pdf_ocr import extract_pdf_pages_with_ocr
        raw = sys.stdin.buffer.read(15 * 1024**2 + 1)
        if len(raw) > 15 * 1024**2:
            raise HTTPException(413, 'PDF exceeds the 15 MB upload limit.')
        try:
            document = pymupdf.open(stream=raw, filetype='pdf')
        except Exception:
            raise HTTPException(400, 'Could not read this PDF.') from None
        with document:
            if document.needs_pass:
                raise HTTPException(400, 'Password-protected PDFs are not supported yet.')
            if document.page_count > 100:
                raise HTTPException(413, 'This server accepts PDFs with up to 100 pages.')
            scanned = 0
            for page in document:
                if page.rect.width * page.rect.height * (150 / 72)**2 > 12_000_000:
                    raise HTTPException(413, 'A PDF page is too large. Resize it before uploading.')
                if len(page.get_text().strip()) < 20 and page.get_images(full=True):
                    scanned += 1
            if scanned > 30:
                raise HTTPException(413, 'This server accepts up to 30 scanned pages per PDF.')
        result = {'status': 200, 'pages': extract_pdf_pages_with_ocr(raw, progress=progress if progress_mode else None)}
    except HTTPException as error:
        result = {'status': error.status_code, 'detail': error.detail}
    except Exception:
        result = {'status': 503, 'detail': 'PDF processing exceeded available capacity. Try a smaller document.'}
    if progress_mode:
        result['type'] = 'result'
    output = json.dumps(result).encode()
    if len(output) > MAX_RESULT_BYTES:
        output = json.dumps({'type': 'result', 'status': 413, 'detail': 'Extracted document text is too large.'}).encode()
    with protocol:
        protocol.write(output + (b'\n' if progress_mode else b''))


if __name__ == '__main__':
    main()
