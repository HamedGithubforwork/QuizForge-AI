"""Single-document subprocess protocol. No database or model credentials needed."""
import json
import os
import resource
import sys

from pdf_protocol import MAX_RESULT_BYTES, validate_checkpoint
from pdf_selection import parse_selection


class _InputError(Exception):
    pass


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

    def progress(pages, total):
        protocol.write(json.dumps({'type': 'pages', 'pages': pages, 'total': total}, separators=(',', ':')).encode() + b'\n')
        protocol.flush()

    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024**2, 768 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (90, 95))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # Import only extraction dependencies; API/model clients stay in the parent.
    from pdf_extraction import PdfError, extract
    try:
        selected = parse_selection(sys.argv[sys.argv.index('--pages') + 1]) if '--pages' in sys.argv else []
        checkpoint = []
        if '--resume' in sys.argv:
            header = sys.stdin.buffer.read(4)
            if len(header) != 4:
                raise _InputError()
            length = int.from_bytes(header, 'big')
            if length > MAX_RESULT_BYTES:
                raise _InputError()
            payload = sys.stdin.buffer.read(length)
            if len(payload) != length:
                raise _InputError()
            checkpoint = json.loads(payload)
            validate_checkpoint(checkpoint, total=len(selected) if selected else 100, page_numbers=selected)
        raw = sys.stdin.buffer.read(15 * 1024**2 + 1)
        if len(raw) > 15 * 1024**2:
            raise PdfError(413, 'PDF exceeds the 15 MB upload limit.')
        result = {'status': 200, 'pages': extract(raw, checkpoint=checkpoint,
                  on_pages=progress if progress_mode else None, page_numbers=selected)}
    except PdfError as error:
        result = {'status': error.status_code, 'detail': error.detail}
    except Exception:
        result = {'status': 503, 'detail': 'PDF processing exceeded available capacity. Try a smaller document.'}
    if progress_mode:
        result['type'] = 'result'
    output = json.dumps(result, separators=(',', ':')).encode()
    if len(output) > MAX_RESULT_BYTES:
        output = json.dumps({'type': 'result', 'status': 413, 'detail': 'Extracted document text is too large.'}).encode()
    with protocol:
        protocol.write(output + (b'\n' if progress_mode else b''))


if __name__ == '__main__':
    main()
