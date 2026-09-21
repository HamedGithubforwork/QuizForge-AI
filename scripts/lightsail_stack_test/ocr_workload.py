"""Runs inside the reviewed API cgroup with no model/network calls."""
import asyncio
import json
import sys
import time
import pymupdf
sys.path.insert(0, '/app/scripts')
from benchmark_pdf_ocr import fixtures, quality
from pdf_process import extract_background

async def main():
    raw, names, references = fixtures()
    with pymupdf.open(stream=raw, filetype='pdf') as source, pymupdf.open() as target:
        for _ in range(6):
            target.insert_pdf(source)
        scanned = target.tobytes()
    start = time.monotonic()
    pages = await extract_background(scanned, timeout=300)
    elapsed = time.monotonic() - start
    scores = [quality(p['text'], references[i % 5]) for i,p in enumerate(pages)]
    assert len(pages) == 30
    assert all(q['precision'] >= .95 and q['recall'] >= .95 for q in scores)
    print(json.dumps({'pages':len(pages),'seconds':elapsed,'minimum_precision':min(q['precision'] for q in scores),
        'minimum_recall':min(q['recall'] for q in scores),'passed':True}))

if __name__ == '__main__':
    asyncio.run(main())
