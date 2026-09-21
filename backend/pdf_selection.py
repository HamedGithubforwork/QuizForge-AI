"""Canonical, bounded page selections and document identities (no PDF imports)."""
import hashlib
import re


def validate_selection(numbers):
    if (not isinstance(numbers, list) or len(numbers) > 100
            or any(type(number) is not int or not 1 <= number <= 100 for number in numbers)
            or numbers != sorted(set(numbers))):
        raise ValueError('Invalid selected pages')
    return numbers


def parse_selection(value):
    if not isinstance(value, str) or len(value) > 400:
        raise ValueError('Use page numbers or ranges, for example 1, 3-5 (pages 1–100).')
    if not value.strip():
        return []
    numbers = set()
    for part in value.split(','):
        match = re.fullmatch(r'\s*([0-9]{1,3})(?:\s*-\s*([0-9]{1,3}))?\s*', part)
        if match is None:
            raise ValueError('Use page numbers or ranges, for example 1, 3-5 (pages 1–100).')
        start = int(match[1])
        end = int(match[2]) if match[2] else start
        if not 1 <= start <= end <= 100:
            raise ValueError('Page ranges must be between 1 and 100, in ascending order.')
        numbers.update(range(start, end + 1))
    return sorted(numbers)


def document_identity(contents, numbers):
    return selection_identity(hashlib.sha256(contents).hexdigest(), numbers)


def selection_identity(digest, numbers):
    validate_selection(numbers)
    if not numbers:
        return digest
    # Different selections must never reuse each other's text or quiz caches.
    selection = ','.join(map(str, numbers))
    return hashlib.sha256(f'quizforge/pdf-selection/v1\0{digest}\0{selection}'.encode()).hexdigest()
