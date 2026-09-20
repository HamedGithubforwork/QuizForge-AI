"""Small, dependency-free bounds shared by the private PDF worker and queue."""
import json

MAX_RESULT_BYTES = 8 * 1024**2
MAX_PAGE_BYTES = MAX_RESULT_BYTES - 1024  # Leave room for the result envelope.


def encode_pages(pages):
    raw = json.dumps(pages, separators=(',', ':')).encode()
    if len(raw) > MAX_PAGE_BYTES:
        raise ValueError('Extracted document text is too large')
    return raw


def validate_pages(pages, *, start=1, total=100):
    if type(total) is not int or not 0 <= total <= 100 or not isinstance(pages, list):
        raise ValueError('Invalid page checkpoint')
    if start < 1 or start + len(pages) - 1 > total:
        raise ValueError('Invalid checkpoint length')
    for number, page in enumerate(pages, start):
        if (not isinstance(page, dict) or set(page) != {'page_number', 'text'}
                or type(page['page_number']) is not int or page['page_number'] != number
                or not isinstance(page['text'], str)):
            raise ValueError('Invalid checkpoint page')
    return encode_pages(pages)
