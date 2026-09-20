import asyncio
import ctypes
import sys

import pymupdf
import pytest
from fastapi import HTTPException

import pdf_extraction
from pdf_job_store import JobStore, MAX_RESULT_BYTES
from pdf_process import extract_background
from pdf_protocol import validate_pages

pytestmark = pytest.mark.skipif(sys.platform != 'linux', reason='The isolated queue requires Linux')

TEXT = 'Photosynthesis transforms sunlight into chemical energy. Chlorophyll absorbs light. ' * 3


def scanned_pdf(count=3):
    with pymupdf.open() as source, pymupdf.open() as target:
        page = source.new_page()
        page.insert_textbox(pymupdf.Rect(40, 40, 550, 400), TEXT, fontsize=14)
        raster = page.get_pixmap(dpi=150).tobytes('png')
        for _ in range(count):
            page = target.new_page()
            page.insert_image(page.rect, stream=raster)
        return target.tobytes()


def test_resume_skips_completed_ocr_pages_and_reuses_one_engine(monkeypatch):
    calls = []
    class Engine:
        def __init__(self): calls.append('create')
        def text(self, page):
            calls.append(page.number)
            return TEXT
        def close(self): calls.append('close')
    monkeypatch.setattr(pdf_extraction, 'OcrEngine', Engine)
    saved = [{'page_number': 1, 'text': 'Previously recognized private text. ' * 8}]
    batches = []
    result = pdf_extraction.extract(scanned_pdf(), checkpoint=saved,
                                    on_pages=lambda pages, total: batches.append((pages, total)))
    assert result[0] == saved[0]
    assert calls == ['create', 1, 2, 'close']
    assert [pages[0]['page_number'] for pages, _ in batches] == [2, 3]
    assert all(total == 3 for _, total in batches)


def test_engine_is_closed_on_checkpoint_failure(monkeypatch):
    closed = []
    class Engine:
        def text(self, page): return TEXT
        def close(self): closed.append(True)
    monkeypatch.setattr(pdf_extraction, 'OcrEngine', Engine)
    def interrupted(*_): raise RuntimeError('interrupted')
    with pytest.raises(RuntimeError):
        pdf_extraction.extract(scanned_pdf(1), on_pages=interrupted)
    assert closed == [True]


@pytest.mark.parametrize('pages', [None, {}, [{'page_number': True, 'text': 'x'}],
    [{'page_number': 2, 'text': 'x'}], [{'page_number': 1, 'text': 4}],
    [{'page_number': 1, 'text': 'x', 'owner': 'bob'}]])
def test_malformed_checkpoint_is_rejected(pages):
    with pytest.raises(ValueError): validate_pages(pages)


@pytest.mark.parametrize('terminal', ['cancel', 'fail', 'expire', 'twice'])
def test_private_checkpoints_are_atomic_bounded_and_securely_discarded(tmp_path, monkeypatch, terminal):
    directory = tmp_path / 'queue'
    store = JobStore(directory)
    marker = 'PRIVATE-SAVED-PAGE-247917'
    row = store.submit('alice', 'notes.pdf', b'private-input')
    store.claim()
    pages = [{'page_number': 1, 'text': marker}]
    store.checkpoint(row['id'], pages, 3)
    assert store.get_owned('alice', row['id'])['result'] is None
    assert store.get_document('alice', row['sha256']) is None
    with pytest.raises(HTTPException): store.get_owned('bob', row['id'])
    with pytest.raises(ValueError): store.checkpoint(row['id'], pages, 3)
    with pytest.raises(ValueError): store.checkpoint(row['id'], [{'page_number': 2, 'text': 'bad'}], 4)
    assert store.get_owned('alice', row['id'])['completed_pages'] == 1
    store.close()
    store = JobStore(directory)
    try:
        recovered = store.get_owned('alice', row['id'])
        assert recovered['state'] == 'queued' and recovered['completed_pages'] == 1 and recovered['total_pages'] == 3
        claimed = store.claim()
        assert claimed['checkpoint'] == pages
        with store.connect() as db:
            assert db.execute('SELECT reserved FROM jobs').fetchone()[0] == len(b'private-input') + MAX_RESULT_BYTES
        if terminal == 'cancel': store.cancel('alice', row['id'])
        elif terminal == 'fail': store.fail(row['id'], 'Failed')
        elif terminal == 'twice': store.recover()
        else:
            monkeypatch.setattr('pdf_job_store.time.time', lambda: row['expires'] + 1)
            store.cleanup()
        with store.connect() as db:
            assert db.execute('SELECT count(*) FROM checkpoints').fetchone()[0] == 0
        assert marker.encode() not in store.path.read_bytes()
        assert b'private-input' not in store.path.read_bytes()
    finally:
        store.close()


def test_existing_version_one_queue_is_migrated_without_losing_upload(tmp_path):
    directory = tmp_path / 'queue'
    store = JobStore(directory)
    row = store.submit('alice', 'notes.pdf', b'old-upload')
    store.claim()
    with store.connect() as db:
        db.execute('DROP TABLE checkpoints')
        db.execute('PRAGMA user_version=1')
        db.execute('UPDATE jobs SET completed_pages=2,total_pages=3')
    store.close()
    store = JobStore(directory)
    try:
        claimed = store.claim()
        assert claimed['id'] == row['id'] and claimed['input'] == b'old-upload'
        assert claimed['completed_pages'] == 0 and claimed['checkpoint'] == []
    finally:
        store.close()


def test_checkpoint_size_failure_does_not_advance_progress(tmp_path, monkeypatch):
    store = JobStore(tmp_path / 'queue')
    try:
        row = store.submit('alice', 'notes.pdf', b'input')
        store.claim()
        monkeypatch.setattr('pdf_job_store.MAX_PAGE_BYTES', 100)
        with pytest.raises(HTTPException) as error:
            store.checkpoint(row['id'], [{'page_number': 1, 'text': 'x' * 200}], 2)
        assert error.value.status_code == 413
        assert store.get_owned('alice', row['id'])['completed_pages'] == 0
        with store.connect() as db:
            assert db.execute('SELECT count(*) FROM checkpoints').fetchone()[0] == 0
    finally:
        store.close()


def test_isolated_extractor_enforces_scan_and_pixel_limits_before_ocr(monkeypatch):
    def unexpected(): raise AssertionError('OCR must not start for rejected documents')
    monkeypatch.setattr(pdf_extraction, 'OcrEngine', unexpected)
    with pytest.raises(pdf_extraction.PdfError) as error:
        pdf_extraction.extract(scanned_pdf(31))
    assert error.value.status_code == 413
    with pymupdf.open() as document:
        document.new_page(width=3000, height=3000)
        raw = document.tobytes()
    with pytest.raises(pdf_extraction.PdfError) as error:
        pdf_extraction.extract(raw)
    assert error.value.status_code == 413


def test_real_child_interruption_resumes_private_committed_pages(tmp_path):
    try:
        ctypes.CDLL('libtesseract.so.5')
        pymupdf.get_tessdata()
    except (OSError, RuntimeError):
        pytest.skip('Native OCR is mandatory in the Docker runtime verification')
    async def scenario():
        directory = tmp_path / 'queue'
        store = JobStore(directory)
        raw = scanned_pdf()
        row = store.submit('alice', 'notes.pdf', raw)
        store.claim()
        async def save_then_interrupt(pages, total):
            store.checkpoint(row['id'], pages, total)
            raise asyncio.CancelledError()
        with pytest.raises(asyncio.CancelledError):
            await extract_background(raw, on_checkpoint=save_then_interrupt)
        store.close()
        store = JobStore(directory)
        try:
            resumed = store.claim()
            assert len(resumed['checkpoint']) == 1
            observed = []
            async def save(pages, total):
                observed.extend(page['page_number'] for page in pages)
                store.checkpoint(row['id'], pages, total)
            result = await extract_background(raw, checkpoint=resumed['checkpoint'], on_checkpoint=save)
            assert observed == [2, 3] and result[0] == resumed['checkpoint'][0]
            store.finish(row['id'], result)
            assert store.get_owned('alice', row['id'])['state'] == 'succeeded'
            with store.connect() as db:
                assert db.execute('SELECT count(*) FROM checkpoints').fetchone()[0] == 0
                assert db.execute('SELECT input FROM jobs').fetchone()[0] is None
        finally:
            store.close()
    asyncio.run(scenario())
