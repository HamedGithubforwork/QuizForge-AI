"""Text quality checks without importing API or model clients."""
MIN_EXTRACTABLE_CHARACTERS = 100
SCAN_CHARACTERS_PER_PAGE = 50


def analyze_extracted_text(pages):
    total_characters = sum(len(page['text']) for page in pages)
    extractable_page_count = sum(len(page['text'].strip()) >= 20 for page in pages)
    scanned_likely = total_characters < max(MIN_EXTRACTABLE_CHARACTERS, len(pages) * SCAN_CHARACTERS_PER_PAGE)
    return {
        'total_characters': total_characters,
        'extractable_page_count': extractable_page_count,
        'scanned_likely': scanned_likely,
        'warning': (
            'Very little selectable text was detected. '
            'This PDF may be scanned or image-based. '
            'OCR support is not available yet.'
        ) if scanned_likely else None,
    }
