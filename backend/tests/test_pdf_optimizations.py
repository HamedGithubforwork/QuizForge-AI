import hashlib
import json

import pytest
from fastapi import HTTPException

import pdf_extraction
import pdf_job_store
from pdf_job_store import JobStore
from pdf_selection import document_identity, parse_selection
from test_pdf_checkpoints import scanned_pdf, TEXT


@pytest.mark.parametrize('value,expected', [('', []), ('  ', []), ('5, 2-4, 3', [2, 3, 4, 5]), ('1-100', list(range(1, 101)))])
def test_parse_selection(value, expected):
    assert parse_selection(value) == expected


@pytest.mark.parametrize('value', ['0', '101', '5-2', '1,,2', '1.5', '-1', '1-', 'all', '1e2', '1' * 401])
def test_reject_invalid_selection(value):
    with pytest.raises(ValueError):
        parse_selection(value)


def test_selection_identity_separates_full_and_partial_documents():
    raw = b'pdf'
    full = document_identity(raw, [])
    assert full == hashlib.sha256(raw).hexdigest()
    assert len({full, document_identity(raw, [2]), document_identity(raw, [1, 2])}) == 3


def finish(store, owner, raw, pages=None, selection=None):
    row = store.submit(owner, 'notes.pdf', raw, selection)
    assert store.claim()['id'] == row['id']
    store.finish(row['id'], pages or [{'page_number': 1, 'text': TEXT}])
    return row


def test_completed_text_lasts_24_hours_without_extending_on_access(tmp_path, monkeypatch):
    now = [10000.0]
    monkeypatch.setattr(pdf_job_store.time, 'time', lambda: now[0])
    store = JobStore(tmp_path / 'queue')
    try:
        row = finish(store, 'alice', b'private-pdf')
        expires = now[0] + 86400
        now[0] += 7200
        cached = store.submit('alice', 'renamed.pdf', b'private-pdf')
        assert cached['id'] == row['id'] and cached['expires'] == expires
        assert store.get_document('alice', row['sha256'])['pages'][0]['text'] == TEXT
        assert store.get_document('bob', row['sha256']) is None
        with store.connect() as db:
            assert db.execute('SELECT input FROM jobs').fetchone()[0] is None
            assert db.execute('SELECT count(*) FROM admissions').fetchone()[0] == 0
        now[0] = expires
        assert store.get_document('alice', row['sha256']) is None
        with pytest.raises(HTTPException): store.get_owned('alice', row['id'])
        store.cleanup()
        assert TEXT.encode() not in store.path.read_bytes()
    finally:
        store.close()


def test_lru_eviction_preserves_hourly_admissions_and_new_hour_accepts_upload(tmp_path, monkeypatch):
    now = [10000.0]
    monkeypatch.setattr(pdf_job_store.time, 'time', lambda: now[0])
    pages = [{'page_number': 1, 'text': TEXT}]
    size = len(json.dumps(pages, separators=(',', ':')).encode())
    monkeypatch.setattr(pdf_job_store, 'MAX_CACHE_BYTES', size * 2)
    store = JobStore(tmp_path / 'queue')
    try:
        first = finish(store, 'alice', b'one', pages)
        now[0] += 1
        second = finish(store, 'alice', b'two', pages)
        now[0] += 1
        assert store.get_document('alice', first['sha256'])
        now[0] += 1
        finish(store, 'alice', b'three', pages)
        assert store.get_document('alice', first['sha256'])
        assert store.get_document('alice', second['sha256']) is None
        finish(store, 'alice', b'four', pages)
        with pytest.raises(HTTPException) as error: store.submit('alice', 'notes.pdf', b'five')
        assert error.value.status_code == 429
        with store.connect() as db:
            assert db.execute('SELECT sum(length(result)) FROM jobs').fetchone()[0] <= size * 2
            assert db.execute('SELECT count(*) FROM admissions').fetchone()[0] == 4
        now[0] += 3601
        assert store.submit('alice', 'notes.pdf', b'five')['state'] == 'queued'
    finally:
        store.close()


def test_selected_scan_limit_and_restart_preserve_original_page_numbers(tmp_path, monkeypatch):
    calls = []
    class Engine:
        def text(self, page):
            calls.append(page.number + 1)
            return TEXT
        def close(self): pass
    monkeypatch.setattr(pdf_extraction, 'OcrEngine', Engine)
    raw, selected = scanned_pdf(31), [2, 17, 31]
    directory = tmp_path / 'queue'
    store = JobStore(directory)
    row = store.submit('alice', 'scan.pdf', raw, selected)
    store.claim()
    def interrupt(batch, total):
        store.checkpoint(row['id'], batch, total)
        raise InterruptedError()
    with pytest.raises(InterruptedError):
        pdf_extraction.extract(raw, page_numbers=selected, on_pages=interrupt)
    store.close()
    store = JobStore(directory)
    try:
        resumed = store.claim()
        pages = pdf_extraction.extract(raw, page_numbers=selected, checkpoint=resumed['checkpoint'],
                                      on_pages=lambda batch, total: store.checkpoint(row['id'], batch, total))
        assert calls == selected
        assert [page['page_number'] for page in pages] == selected
        store.finish(row['id'], pages)
        assert store.get_document('alice', row['sha256'])['pages'] == pages
        assert store.submit('alice', 'scan.pdf', raw, selected)['id'] == row['id']
        with pytest.raises(pdf_extraction.PdfError) as error: pdf_extraction.extract(raw)
        assert error.value.status_code == 413
        with pytest.raises(pdf_extraction.PdfError) as error: pdf_extraction.extract(raw, page_numbers=[32])
        assert error.value.status_code == 400
        with pytest.raises(pdf_extraction.PdfError) as error: pdf_extraction.extract(scanned_pdf(101), page_numbers=[1])
        assert error.value.status_code == 413
    finally:
        store.close()


def test_version_two_migration_preserves_checkpoint_expiry_and_admission(tmp_path):
    directory = tmp_path / 'queue'
    store = JobStore(directory)
    row = store.submit('alice', 'old.pdf', b'old-private-input')
    store.claim()
    page = {'page_number': 1, 'text': TEXT}
    store.checkpoint(row['id'], [page], 2)
    with store.connect() as db:
        db.execute('DROP TABLE admissions')
        db.execute('ALTER TABLE jobs DROP COLUMN selection')
        db.execute('ALTER TABLE jobs DROP COLUMN accessed')
        db.execute('PRAGMA user_version=2')
    store.close()
    store = JobStore(directory)
    try:
        recovered = store.claim()
        assert recovered['input'] == b'old-private-input'
        assert recovered['checkpoint'] == [page]
        assert recovered['expires'] == row['expires']
        assert recovered['selection'] == '[]'
        with store.connect() as db:
            assert db.execute('PRAGMA user_version').fetchone()[0] == 4
            assert db.execute('SELECT count(*) FROM admissions').fetchone()[0] == 1
    finally:
        store.close()


def test_quiz_focus_cannot_include_an_unprocessed_page(monkeypatch):
    import asyncio
    from quiz_service import generate_quiz_from_pages
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    with pytest.raises(HTTPException) as error:
        asyncio.run(generate_quiz_from_pages(pages=[{'page_number': 7, 'text': TEXT}],
            question_count=5, difficulty='medium', question_type='multiple_choice', focus_pages='2'))
    assert error.value.status_code == 400 and 'among the pages processed' in error.value.detail
    # Page 7 is allowed even though there is only one processed page; execution
    # reaches the missing-model-key check without making an external model call.
    with pytest.raises(HTTPException) as error:
        asyncio.run(generate_quiz_from_pages(pages=[{'page_number': 7, 'text': TEXT}],
            question_count=5, difficulty='medium', question_type='multiple_choice', focus_pages='7'))
    assert error.value.status_code == 500 and 'not configured' in error.value.detail
