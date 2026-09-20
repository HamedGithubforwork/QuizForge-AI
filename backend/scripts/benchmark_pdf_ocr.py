"""Compare OCR settings on deterministic scans; never calls a paid service.

Run in the locked backend environment with OMP_THREAD_LIMIT=1. Results are
local diagnostics, not Lightsail capacity evidence or a real-document corpus.
"""
import argparse
from collections import Counter
from difflib import SequenceMatcher
import json
import os
from pathlib import Path
import re
import statistics
import sys
import time

os.environ.setdefault('OMP_THREAD_LIMIT', '1')
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pymupdf
import pdf_native_ocr

LESSON = (
    'Photosynthesis converts sunlight into chemical energy. Chlorophyll absorbs light. '
    'Plants use water and carbon dioxide to produce glucose and oxygen. '
    'Mitochondria release stored energy through cellular respiration. '
    'A balanced ecosystem includes producers, consumers, and decomposers. '
)
SECOND = (
    'Neurons transmit electrical signals between the brain and other body tissues. '
    'The nucleus stores genetic information in chromosomes. Enzymes increase reaction rates. '
    'A laboratory sample contains 125 cells in 5 groups. Temperature is measured in degrees Celsius. '
)


def fixtures():
    expected, names = [], ['single-column', 'two-columns', 'small-text', 'colored-page', 'rotated-metadata']
    with pymupdf.open() as source, pymupdf.open() as target:
        for name in names:
            page = source.new_page(width=595, height=842)
            text = LESSON * 3
            if name == 'colored-page':
                page.draw_rect(page.rect, fill=(0.92, 0.96, 1), color=None)
            if name == 'two-columns':
                left, right = LESSON * 3, SECOND * 3
                assert page.insert_textbox(pymupdf.Rect(40, 40, 282, 800), left, fontsize=10) >= 0
                assert page.insert_textbox(pymupdf.Rect(312, 40, 555, 800), right, fontsize=10) >= 0
                text = left + right
            else:
                assert page.insert_textbox(pymupdf.Rect(40, 40, 555, 800), text,
                    fontsize=9 if name == 'small-text' else 12,
                    color=(0.12, 0.17, 0.35) if name == 'colored-page' else (0, 0, 0)) >= 0
            matrix = pymupdf.Matrix(150 / 72, 150 / 72)
            rotated = name == 'rotated-metadata'
            if rotated:
                matrix = matrix.prerotate(90)
            raster = page.get_pixmap(matrix=matrix, alpha=False)
            scan = target.new_page(width=842 if rotated else 595, height=595 if rotated else 842)
            scan.insert_image(scan.rect, stream=raster.tobytes('jpeg', jpg_quality=80))
            if rotated:
                scan.set_rotation(270)
            expected.append(text)
        return target.tobytes(), names, expected


def quality(text, reference):
    tokens = re.findall(r'[a-z0-9]+', text.lower())
    expected = re.findall(r'[a-z0-9]+', reference.lower())
    overlap = sum((Counter(tokens) & Counter(expected)).values())
    return {'precision': overlap / max(1, len(tokens)), 'recall': overlap / len(expected),
            'reading_order': SequenceMatcher(None, expected, tokens, autojunk=False).ratio()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10:
        parser.error('repeats must be 1–10')
    raw, names, expected = fixtures()
    original_dpi = pdf_native_ocr.OCR_DPI
    variants = [('rgb-150-auto', pymupdf.csRGB, 150, 3), ('gray-150-auto', pymupdf.csGRAY, 150, 3),
                ('gray-150-block', pymupdf.csGRAY, 150, 6), ('gray-120-auto', pymupdf.csGRAY, 120, 3)]
    reports = {name: {'wall_seconds': [], 'cpu_seconds': [], 'pages': []} for name, *_ in variants}
    try:
        # Rotate order each repeat to reduce systematic warm-up bias.
        for repeat in range(args.repeats):
            ordered = variants[repeat % len(variants):] + variants[:repeat % len(variants)]
            for name, color, dpi, psm in ordered:
                pdf_native_ocr.OCR_DPI = dpi
                start, cpu = time.perf_counter(), time.process_time()
                with pymupdf.open(stream=raw, filetype='pdf') as document:
                    engine = pdf_native_ocr.OcrEngine(colorspace=color)
                    try:
                        engine.lib.TessBaseAPISetPageSegMode(engine.handle, psm)
                        results = [engine.text(page) for page in document]
                    finally:
                        engine.close()
                report = reports[name]
                report['wall_seconds'].append(time.perf_counter() - start)
                report['cpu_seconds'].append(time.process_time() - cpu)
                report['pages'] = [{'name': page, **quality(text, reference)}
                    for page, text, reference in zip(names, results, expected)]
                print(f'Completed {name}, repeat {repeat + 1}', file=sys.stderr, flush=True)
    finally:
        pdf_native_ocr.OCR_DPI = original_dpi
    for report in reports.values():
        report['median_wall_seconds'] = statistics.median(report['wall_seconds'])
        report['median_cpu_seconds'] = statistics.median(report['cpu_seconds'])
    result = {'environment': 'local diagnostic; synthetic scans; one OCR thread',
              'python': sys.version.split()[0], 'pymupdf': pymupdf.VersionBind,
              'repeats': args.repeats, 'variants': reports}
    output = json.dumps(result, indent=2) + '\n'
    if args.output:
        args.output.write_text(output)
    print(output)


if __name__ == '__main__':
    main()
