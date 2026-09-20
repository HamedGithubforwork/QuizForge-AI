"""Synthetic, paired OCR diagnostic; only the benchmark image runs this wrapper.

The original capacity harness runs first without modification. Afterwards, fresh
workers alternate RGB/gray on identical PDFs in the same container/CPU quota.
No application code, OCR resolution, page layout or capacity target is changed.
"""
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time

PAIRS = 6
VARIANTS = ('rgb', 'gray')
HERE = Path(__file__).resolve().parent
RESULTS = Path('/results')
CGROUP = Path('/sys/fs/cgroup')


def order(pair):
    return VARIANTS if pair % 2 == 0 else VARIANTS[::-1]


def cpu_stat():
    path = CGROUP / 'cpu.stat'
    return {k: int(v) for k, v in (line.split() for line in path.read_text().splitlines())}


def timed(call, totals, name):
    wall, cpu = time.perf_counter(), time.process_time()
    try:
        return call()
    finally:
        totals[name + '_wall'] = totals.get(name + '_wall', 0) + time.perf_counter() - wall
        totals[name + '_cpu'] = totals.get(name + '_cpu', 0) + time.process_time() - cpu


class MeasuredPixmap:
    def __init__(self, pixmap, totals):
        self.pixmap, self.totals = pixmap, totals

    def __getattr__(self, name):
        return getattr(self.pixmap, name)

    @property
    def samples(self):
        return timed(lambda: self.pixmap.samples, self.totals, 'buffer_copy')


class MeasuredPage:
    def __init__(self, page, totals):
        self.page, self.totals = page, totals

    @property
    def rect(self):
        return self.page.rect

    def get_pixmap(self, **kwargs):
        return MeasuredPixmap(timed(lambda: self.page.get_pixmap(**kwargs), self.totals, 'render'), self.totals)


def prepare_fixtures(root):
    import run as capacity
    import pymupdf
    from scripts.benchmark_pdf_ocr import fixtures
    root.mkdir()
    # The first corpus uses the unchanged capacity harness's dense scan factory.
    dense = capacity.fixture(5, True, 'controlled-comparison')
    with pymupdf.open(stream=capacity.fixture(5, False, 'controlled-comparison'), filetype='pdf') as doc:
        expected = [page.get_text() for page in doc]
    quality_pdf, names, quality_expected = fixtures()
    manifest = []
    for name, raw, page_names, references in (
        ('capacity', dense, [f'dense-{i+1}' for i in range(5)], expected),
        ('quality', quality_pdf, names, quality_expected),
    ):
        (root / (name + '.pdf')).write_bytes(raw)
        manifest.append({'name': name, 'sha256': hashlib.sha256(raw).hexdigest(),
                         'page_names': page_names, 'expected': references})
    (root / 'manifest.json').write_text(json.dumps(manifest))
    return manifest


def worker(variant, root):
    import resource
    import pymupdf
    import pdf_native_ocr
    from scripts.benchmark_pdf_ocr import quality
    if variant not in VARIANTS:
        raise ValueError('Only the two fixed color settings are allowed')
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024**2, 768 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (90, 95))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    assert os.environ['OMP_THREAD_LIMIT'] == '1'
    assert pdf_native_ocr.OCR_DPI == 150
    colorspace = pymupdf.csRGB if variant == 'rgb' else pymupdf.csGRAY
    manifest = json.loads((root / 'manifest.json').read_text())
    corpora = []
    for item in manifest:
        raw = (root / (item['name'] + '.pdf')).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == item['sha256']
        timings, texts = {}, []
        before = cpu_stat()
        def extract():
            with pymupdf.open(stream=raw, filetype='pdf') as document:
                engine = timed(lambda: pdf_native_ocr.OcrEngine(colorspace=colorspace), timings, 'engine_init')
                recognize = engine.lib.TessBaseAPIGetUTF8Text
                engine.lib.TessBaseAPIGetUTF8Text = lambda handle: timed(lambda: recognize(handle), timings, 'recognition')
                try:
                    for page in document:
                        texts.append(engine.text(MeasuredPage(page, timings)))
                finally:
                    engine.close()
        timed(extract, timings, 'total')
        after = cpu_stat()
        assert len(texts) == len(item['expected']) == len(item['page_names'])
        scores = [quality(text, expected) for text, expected in zip(texts, item['expected'])]
        corpora.append({'name': item['name'], 'fixture_sha256': item['sha256'],
            'timings': timings, 'cgroup_cpu_delta': {k: after[k] - before[k] for k in before},
            'text_sha256': hashlib.sha256(json.dumps(texts).encode()).hexdigest(),
            'pages': [{'name': name, **score} for name, score in zip(item['page_names'], scores)]})
    return {'variant': variant, 'corpora': corpora,
            'max_worker_rss_mib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024}


def summarize(samples):
    assert len(samples) == PAIRS * 2
    assert {(s['pair'], s['variant']) for s in samples} == {(p, v) for p in range(PAIRS) for v in VARIANTS}
    assert all(order(s['pair'])[s['position']] == s['variant'] for s in samples)
    result = {}
    for corpus in ('capacity', 'quality'):
        arms = {v: [next(c for c in s['corpora'] if c['name'] == corpus)
                    for s in samples if s['variant'] == v] for v in VARIANTS}
        assert all(len(v) == PAIRS for v in arms.values())
        assert len({c['fixture_sha256'] for rows in arms.values() for c in rows}) == 1
        medians = {v: {metric: statistics.median(c['timings'][metric] for c in rows)
                       for metric in rows[0]['timings']} for v, rows in arms.items()}
        paired = [(g['timings']['total_wall'] / r['timings']['total_wall'] - 1) * 100
                  for r, g in zip(arms['rgb'], arms['gray'])]
        quality_ok = all(min(p[k] for k in ('precision', 'recall', 'reading_order')) >= .99
                         for rows in arms.values() for c in rows for p in c['pages'])
        gray_quality_no_worse = all(gp[k] + 1e-12 >= rp[k]
            for r, g in zip(arms['rgb'], arms['gray']) for rp, gp in zip(r['pages'], g['pages'])
            for k in ('precision', 'recall', 'reading_order'))
        result[corpus] = {'median_timings': medians,
            'gray_wall_change_percent': (medians['gray']['total_wall'] / medians['rgb']['total_wall'] - 1) * 100,
            'gray_cpu_change_percent': (medians['gray']['total_cpu'] / medians['rgb']['total_cpu'] - 1) * 100,
            'paired_gray_wall_change_percent': paired,
            'gray_faster_pairs': sum(value < 0 for value in paired),
            'quality_passed': quality_ok, 'gray_quality_no_worse': gray_quality_no_worse,
            'identical_text_in_all_pairs': all(r['text_sha256'] == g['text_sha256'] for r, g in zip(arms['rgb'], arms['gray']))}
    return result


def comparison():
    import platform
    import pymupdf
    assert Path('/capacity-test-image').is_file()
    assert sorted(p.name for p in Path('/sys/class/net').iterdir()) == ['lo']
    assert not any(k.startswith(('AWS_', 'SUPABASE_')) for k in os.environ)
    assert int((CGROUP / 'memory.max').read_text()) == 1536 * 1024**2
    assert (CGROUP / 'memory.swap.max').read_text().strip() == '0'
    quota, period = map(int, (CGROUP / 'cpu.max').read_text().split())
    assert quota / period in (.4, 2)
    root = Path('/tmp/ocr-comparison')
    manifest = prepare_fixtures(root)
    report = {'application_sha': os.environ['APPLICATION_SHA'],
        'comparison_script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'synthetic_data': True, 'paid_model_calls': 0, 'cpu_limit': quota / period,
        'python': platform.python_version(), 'pymupdf': pymupdf.VersionBind,
        'pairs': PAIRS, 'warmups_per_variant': 1, 'dpi': 150, 'page_segmentation_mode': 3,
        'ocr_threads': 1, 'whole_application_comparison': False,
        'fixtures': [{k: v for k, v in item.items() if k != 'expected'} for item in manifest],
        'samples': [], 'warmups': [], 'passed': False}
    def save():
        (RESULTS / 'ocr-comparison.json').write_text(json.dumps(report, indent=2) + '\n')
    try:
        for pair in range(-1, PAIRS):
            for position, variant in enumerate(order(pair)):
                result = subprocess.run([sys.executable, str(Path(__file__)), '--worker', variant, str(root)],
                                        check=True, capture_output=True, text=True, timeout=120)
                sample = json.loads(result.stdout)
                sample.update(pair=pair, position=position)
                report['warmups' if pair == -1 else 'samples'].append(sample)
                save()
                print(f'OCR comparison: pair {pair}, {variant} completed', flush=True)
        report['summary'] = summarize(report['samples'])
        report['memory_peak_mib'] = int((CGROUP / 'memory.peak').read_text()) / 1024**2
        report['memory_events'] = {k: int(v) for k, v in
            (line.split() for line in (CGROUP / 'memory.events').read_text().splitlines())}
        report['passed'] = (all(c['quality_passed'] for c in report['summary'].values())
                            and report['memory_events'].get('oom', 0) == 0
                            and report['memory_events'].get('oom_kill', 0) == 0)
    except Exception as error:
        report['error'] = type(error).__name__ + ': ' + str(error)
        raise
    finally:
        save()
    return report['passed']


def main():
    if len(sys.argv) == 4 and sys.argv[1] == '--worker':
        print(json.dumps(worker(sys.argv[2], Path(sys.argv[3]))))
        return 0
    if sys.argv[1:] == ['--diagnostic-only']:
        return 0 if comparison() else 1
    assert len(sys.argv) == 1
    # Keep every original acceptance case/threshold, and its report, untouched.
    result = subprocess.run([sys.executable, str(HERE / 'run.py')], check=False)
    if result.returncode:
        return result.returncode
    return 0 if comparison() else 1


if __name__ == '__main__':
    raise SystemExit(main())
