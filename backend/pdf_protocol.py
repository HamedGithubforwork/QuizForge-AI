"""Small, dependency-free bounds shared by the private PDF worker and queue."""
import json
from pdf_selection import validate_selection

MAX_RESULT_BYTES = 8 * 1024**2
MAX_PAGE_BYTES = MAX_RESULT_BYTES - 1024  # Leave room for the result envelope.


def encode_pages(pages):
    raw = json.dumps(pages, separators=(',', ':')).encode()
    if len(raw) > MAX_PAGE_BYTES:
        raise ValueError('Extracted document text is too large')
    return raw


def validate_pages(pages, *, start=1, total=100, page_numbers=None):
    if type(total) is not int or not 0 <= total <= 100 or not isinstance(pages, list):
        raise ValueError('Invalid page checkpoint')
    if start < 1 or start + len(pages) - 1 > total:
        raise ValueError('Invalid checkpoint length')
    selected = [] if page_numbers is None else validate_selection(page_numbers)
    if selected and (total != len(selected) or start + len(pages) - 1 > len(selected)):
        raise ValueError('Invalid selected checkpoint length')
    expected = selected[start - 1:start - 1 + len(pages)] if selected else range(start, start + len(pages))
    for number, page in zip(expected, pages):
        if (not isinstance(page, dict) or set(page) != {'page_number', 'text'}
                or type(page['page_number']) is not int or page['page_number'] != number
                or not isinstance(page['text'], str)):
            raise ValueError('Invalid checkpoint page')
    return encode_pages(pages)


def validate_checkpoint(pages, *, total=100, page_numbers=None):
    """Allow a sorted subset for reused pages; final results still require every page."""
    if type(total) is not int or not 0 <= total <= 100 or not isinstance(pages, list):
        raise ValueError('Invalid page checkpoint')
    selected = [] if page_numbers is None else validate_selection(page_numbers)
    if selected and total != len(selected):
        raise ValueError('Invalid selected checkpoint length')
    allowed = set(selected or range(1, total + 1))
    previous = 0
    for page in pages:
        if (not isinstance(page, dict) or set(page) != {'page_number', 'text'}
                or type(page['page_number']) is not int or page['page_number'] not in allowed
                or page['page_number'] <= previous or not isinstance(page['text'], str)):
            raise ValueError('Invalid checkpoint page')
        previous = page['page_number']
    return encode_pages(pages)


def validate_next_pages(pages, processed, *, total, page_numbers=None):
    raw = validate_checkpoint(pages, total=total, page_numbers=page_numbers)
    allowed = page_numbers or list(range(1, total + 1))
    if not processed <= set(allowed):
        raise ValueError('Invalid saved pages')
    remaining = [number for number in allowed if number not in processed]
    if not pages or [page['page_number'] for page in pages] != remaining[:len(pages)]:
        raise ValueError('Invalid checkpoint progress')
    return raw
