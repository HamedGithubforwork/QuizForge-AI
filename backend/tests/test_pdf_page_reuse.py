"""Changed selections reuse only safe, private, unexpired page text."""
import asyncio
import hashlib

import pytest

import pdf_extraction
import pdf_job_store
from pdf_job_store import JobStore
from pdf_process import extract_background
from pdf_protocol import validate_checkpoint
from test_pdf_checkpoints import scanned_pdf, TEXT
from test_pdf_jobs import pdf_bytes


def process(store, row, raw, selection):
    claimed = store.claim()
    assert claimed['id'] == row['id']
    pages = pdf_extraction.extract(raw, page_numbers=selection, checkpoint=claimed['checkpoint'],
                                  on_pages=lambda batch, total: store.checkpoint(row['id'], batch, total))
    store.finish(row['id'], pages)
    return store.get_owned(row['owner'], row['id'])


def test_overlap_reuses_only_requested_pages_and_survives_restart(tmp_path, monkeypatch):
    calls = []
    class Engine:
        def text(self, page):
            calls.append(page.number + 1)
            return TEXT + f' Page {page.number + 1}.'
        def close(self): pass
    monkeypatch.setattr(pdf_extraction, 'OcrEngine', Engine)
    raw = scanned_pdf(15)
    store = JobStore(tmp_path / 'queue')
    first = process(store, store.submit('alice', 'scan.pdf', raw, list(range(1, 11))), raw, list(range(1, 11)))
    calls.clear()
    selected = list(range(5, 16))
    second = store.submit('alice', 'renamed.pdf', raw, selected)
    assert second['reused_pages'] == second['completed_pages'] == 6
    assert second['total_pages'] == 11
    assert second['source_sha256'] == hashlib.sha256(raw).hexdigest()
    assert second['sha256'] != first['sha256']
    store.claim()  # Simulate interruption before any new page finishes.
    store.close()
    store = JobStore(tmp_path / 'queue')
    try:
        result = process(store, second, raw, selected)
        assert calls == [11, 12, 13, 14, 15]
        assert [page['page_number'] for page in result['result']] == selected
        assert result['result'][:6] == first['result'][4:]
        assert result['expires'] == first['expires']
        with store.connect() as db:
            assert db.execute('SELECT count(*) FROM checkpoints').fetchone()[0] == 0
            assert db.execute('SELECT count(*) FROM jobs WHERE input IS NOT NULL').fetchone()[0] == 0
        calls.clear()
        subset = process(store, store.submit('alice', 'scan.pdf', raw, [2, 5, 15]), raw, [2, 5, 15])
        assert subset['reused_pages'] == 3 and calls == []
        assert [page['page_number'] for page in subset['result']] == [2, 5, 15]
        calls.clear()
        all_pages = process(store, store.submit('alice', 'scan.pdf', raw), raw, [])
        assert all_pages['reused_pages'] == 15 and calls == []
        assert len(all_pages['result']) == 15
    finally:
        store.close()


@pytest.mark.parametrize('mismatch', ['owner', 'file', 'version', 'near_expiry', 'expired', 'cancelled'])
def test_cache_isolation_and_lifetime(tmp_path, monkeypatch, mismatch):
    now = [10000.0]
    monkeypatch.setattr(pdf_job_store.time, 'time', lambda: now[0])
    store = JobStore(tmp_path / 'queue')
    try:
        first = store.submit('alice', 'same-name.pdf', b'file', [2])
        store.claim()
        store.finish(first['id'], [{'page_number': 2, 'text': TEXT}])
        if mismatch == 'version': monkeypatch.setattr(pdf_job_store, 'EXTRACTION_VERSION', 'next-version')
        if mismatch == 'near_expiry': now[0] += 86400 - 3600
        if mismatch == 'expired': now[0] += 86400
        if mismatch == 'cancelled': store.cancel('alice', first['id'])
        owner = 'bob' if mismatch == 'owner' else 'alice'
        raw = b'different-file' if mismatch == 'file' else b'file'
        second = store.submit(owner, 'same-name.pdf', raw, [1, 2])
        assert second['reused_pages'] == second['completed_pages'] == 0
        assert store.claim()['checkpoint'] == []
    finally:
        store.close()


def test_sparse_checkpoint_batches_are_ordered_bounded_and_atomic(tmp_path):
    store = JobStore(tmp_path / 'queue')
    try:
        first = store.submit('alice', 'scan.pdf', b'file', [2, 4])
        store.claim()
        store.finish(first['id'], [{'page_number': n, 'text': TEXT} for n in [2, 4]])
        second = store.submit('alice', 'scan.pdf', b'file', [1, 2, 3, 4, 5])
        store.claim()
        for invalid in ([2], [3], [1, 2], [5]):
            with pytest.raises(ValueError):
                store.checkpoint(second['id'], [{'page_number': n, 'text': TEXT} for n in invalid], 5)
        assert store.get_owned('alice', second['id'])['completed_pages'] == 2
        store.checkpoint(second['id'], [{'page_number': n, 'text': TEXT} for n in [1, 3]], 5)
        assert store.get_owned('alice', second['id'])['completed_pages'] == 4
        store.cancel('alice', second['id'])
        with store.connect() as db:
            assert db.execute('SELECT count(*) FROM checkpoints WHERE job_id=?', (second['id'],)).fetchone()[0] == 0
            assert tuple(db.execute('SELECT input,result,reserved FROM jobs WHERE id=?', (second['id'],)).fetchone()) == (None, None, 0)
    finally:
        store.close()


def test_reselection_cannot_extend_cache_ttl(tmp_path, monkeypatch):
    now = [10000.0]
    monkeypatch.setattr(pdf_job_store.time, 'time', lambda: now[0])
    store = JobStore(tmp_path / 'queue')
    try:
        for index, selection in enumerate(([1], [1, 2], [1, 2, 3])):
            now[0] += 7200
            row = store.submit('alice', 'scan.pdf', b'file', selection)
            store.claim()
            store.finish(row['id'], [{'page_number': n, 'text': TEXT} for n in selection])
            expiry = store.get_owned('alice', row['id'])['expires']
            if index == 0: original_expiry = expiry
            assert expiry == original_expiry
        now[0] = original_expiry
        store.cleanup()
        assert TEXT.encode() not in store.path.read_bytes()
    finally:
        store.close()


def test_version_three_upgrade_keeps_old_results_but_does_not_seed_them(tmp_path):
    directory = tmp_path / 'queue'
    store = JobStore(directory)
    row = store.submit('alice', 'old.pdf', b'file', [2])
    store.claim()
    store.finish(row['id'], [{'page_number': 2, 'text': TEXT}])
    with store.connect() as db:
        db.execute('DROP INDEX jobs_source')
        for column in ('source_sha256', 'extraction_version', 'reused_pages', 'cache_expires'):
            db.execute(f'ALTER TABLE jobs DROP COLUMN {column}')
        db.execute('PRAGMA user_version=3')
    store.close()
    store = JobStore(directory)
    try:
        assert store.get_owned('alice', row['id'])['result'][0]['text'] == TEXT
        assert store.submit('alice', 'old.pdf', b'file', [1, 2])['reused_pages'] == 0
        with store.connect() as db:
            assert db.execute('PRAGMA user_version').fetchone()[0] == 4
    finally:
        store.close()


@pytest.mark.parametrize('pages', [
    [{'page_number': 2, 'text': TEXT}, {'page_number': 2, 'text': TEXT}],
    [{'page_number': 4, 'text': TEXT}, {'page_number': 2, 'text': TEXT}],
    [{'page_number': 3, 'text': TEXT}], [{'page_number': True, 'text': TEXT}],
    [{'page_number': 2, 'text': 12}], [{'page_number': 2, 'text': TEXT, 'extra': 1}],
])
def test_sparse_protocol_rejects_invalid_seeds(pages):
    with pytest.raises(ValueError): validate_checkpoint(pages, total=2, page_numbers=[2, 4])


def test_real_child_sparse_resume_flushes_new_text_before_cached_last_page():
    raw = pdf_bytes()
    first = asyncio.run(extract_background(raw))
    batches = []
    async def save(batch, total):
        assert total == 2
        batches.extend(batch)
    result = asyncio.run(extract_background(raw, checkpoint=[first[1]], on_checkpoint=save))
    assert result == first and batches == [first[0]]
    batches.clear()
    result = asyncio.run(extract_background(raw, checkpoint=first, on_checkpoint=save))
    assert result == first and batches == []


def test_combined_seed_text_bound_rejects_before_admission(tmp_path, monkeypatch):
    import pdf_protocol
    from fastapi import HTTPException
    store = JobStore(tmp_path / 'queue')
    try:
        for number in [1, 2]:
            row = store.submit('alice', 'scan.pdf', b'file', [number])
            store.claim()
            store.finish(row['id'], [{'page_number': number, 'text': TEXT}])
        monkeypatch.setattr(pdf_protocol, 'MAX_PAGE_BYTES', len(TEXT))
        with pytest.raises(HTTPException) as error:
            store.submit('alice', 'scan.pdf', b'file', [1, 2])
        assert error.value.status_code == 413
        with store.connect() as db:
            assert db.execute('SELECT count(*) FROM jobs').fetchone()[0] == 2
            assert db.execute('SELECT count(*) FROM admissions').fetchone()[0] == 2
            assert db.execute('SELECT count(*) FROM checkpoints').fetchone()[0] == 0
    finally:
        store.close()


def test_cached_reselection_does_not_consume_hourly_document_allowance(tmp_path):
    store = JobStore(tmp_path / 'queue')
    try:
        raw = b'same-document'
        source_digest = hashlib.sha256(raw).hexdigest()

        # Fill the per-owner hourly admission allowance with real processing.
        for number in [1, 2, 3, 4]:
            row = store.submit('alice', 'notes.pdf', raw, [number])
            store.claim()
            store.finish(row['id'], [{'page_number': number, 'text': TEXT}])

        with store.connect() as db:
            assert db.execute(
                'SELECT count(*) FROM admissions WHERE owner=?',
                ('alice',),
            ).fetchone()[0] == pdf_job_store.MAX_OWNER_JOBS

        # A new selection assembled entirely from cached pages must still work:
        # it does not upload bytes or invoke OCR, so it is not a new admission.
        combined = store.reuse_selection(
            'alice',
            source_digest,
            [1, 2, 3, 4],
        )
        assert combined is not None
        assert combined['reused_pages'] == 4
        assert [page['page_number'] for page in combined['result']] == [1, 2, 3, 4]

        with store.connect() as db:
            assert db.execute(
                'SELECT count(*) FROM admissions WHERE owner=?',
                ('alice',),
            ).fetchone()[0] == pdf_job_store.MAX_OWNER_JOBS
    finally:
        store.close()
