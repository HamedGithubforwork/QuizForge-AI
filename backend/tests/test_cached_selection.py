"""Cache-only selections must never enqueue work or extend content retention."""
import hashlib
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import HTTPException

import pdf_job_store as queue
from pdf_job_store import JobStore
from pdf_selection import selection_identity

TEXT = 'Photosynthesis converts sunlight into stored chemical energy. ' * 8
SOURCE = hashlib.sha256(b'original-pdf').hexdigest()


def complete(store, selection, owner='alice'):
    row = store.submit(owner, 'notes.pdf', b'original-pdf', selection)
    store.claim()
    store.finish(row['id'], [{'page_number': n, 'text': TEXT + str(n)} for n in selection or [1, 2, 3]])
    return store.get_owned(owner, row['id'])


def test_combines_cached_pages_without_raw_input_worker_or_ttl_extension(tmp_path, monkeypatch):
    now = [10000.0]
    monkeypatch.setattr(queue.time, 'time', lambda: now[0])
    store = JobStore(tmp_path / 'jobs')
    first = complete(store, [1, 2])
    now[0] += 60
    complete(store, [2, 3])
    store.close()
    store = JobStore(tmp_path / 'jobs')
    try:
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda _: store.reuse_selection('alice', SOURCE, [1, 3]), range(3)))
        assert len({r['id'] for r in results}) == 1
        result = results[0]
        assert result['state'] == 'succeeded' and result['attempts'] == 0
        assert result['reused_pages'] == 2
        assert result['sha256'] == selection_identity(SOURCE, [1, 3])
        assert result['expires'] == first['expires']
        assert [p['page_number'] for p in result['result']] == [1, 3]
        assert store.claim() is None
        with store.connect() as db:
            assert db.execute('SELECT count(*) FROM jobs WHERE input IS NOT NULL').fetchone()[0] == 0
            assert db.execute('SELECT count(*) FROM checkpoints').fetchone()[0] == 0
            assert db.execute('SELECT count(*) FROM admissions').fetchone()[0] == 2
        # Even a cached contiguous prefix cannot establish the full PDF length.
        assert store.reuse_selection('alice', SOURCE, []) is None
        now[0] = first['expires']
        assert store.reuse_selection('alice', SOURCE, [1, 3]) is None
    finally:
        store.close()


@pytest.mark.parametrize('boundary', ['owner', 'source', 'version', 'cancelled', 'expired', 'missing'])
def test_miss_reveals_nothing_and_creates_no_job(tmp_path, monkeypatch, boundary):
    store = JobStore(tmp_path / 'jobs')
    try:
        first = complete(store, [1, 2])
        if boundary == 'version': monkeypatch.setattr(queue, 'EXTRACTION_VERSION', 'new-version')
        if boundary == 'cancelled': store.cancel('alice', first['id'])
        if boundary == 'expired': monkeypatch.setattr(queue.time, 'time', lambda: first['expires'])
        owner = 'bob' if boundary == 'owner' else 'alice'
        source = 'f' * 64 if boundary == 'source' else SOURCE
        selected = [1, 3] if boundary == 'missing' else [1]
        assert store.reuse_selection(owner, source, selected) is None
        assert store.claim() is None
        with store.connect() as db:
            assert db.execute('SELECT count(*) FROM jobs').fetchone()[0] <= 1
    finally:
        store.close()


def test_all_pages_requires_a_full_result_and_cached_results_work_while_worker_busy(tmp_path):
    store = JobStore(tmp_path / 'jobs')
    try:
        first = complete(store, [])
        assert store.reuse_selection('alice', SOURCE, [])['id'] == first['id']
        pending = store.submit('alice', 'other.pdf', b'new-pdf')
        derived = store.reuse_selection('alice', SOURCE, [2])
        assert derived['state'] == 'succeeded'
        assert store.claim()['id'] == pending['id']
    finally:
        store.close()


def test_derived_cache_obeys_memory_bounds_without_spending_admission(tmp_path, monkeypatch):
    store = JobStore(tmp_path / 'jobs')
    try:
        first = complete(store, [])
        original_size = sum(len(p['text']) for p in first['result'])
        monkeypatch.setattr(queue, 'MAX_CACHE_BYTES', original_size)
        result = store.reuse_selection('alice', SOURCE, [1])
        assert result['state'] == 'succeeded'
        with store.connect() as db:
            assert db.execute("SELECT sum(length(result)) FROM jobs WHERE state='succeeded'").fetchone()[0] <= original_size
            assert db.execute('SELECT count(*) FROM jobs WHERE id=?', (first['id'],)).fetchone()[0] == 0
            assert db.execute(
                'SELECT count(*) FROM admissions WHERE owner=?',
                ('alice',),
            ).fetchone()[0] == 1

        # Cache-only reuse remains free, while real processing still consumes
        # and enforces the original hourly admission allowance.
        monkeypatch.setattr(queue, 'MAX_OWNER_JOBS', 2)
        assert store.reuse_selection('alice', SOURCE, [1])['id'] == result['id']

        second = store.submit('alice', 'another.pdf', b'another')
        store.claim()
        store.finish(second['id'], [{'page_number': 1, 'text': TEXT}])

        with pytest.raises(HTTPException) as error:
            store.submit('alice', 'third.pdf', b'third')
        assert error.value.status_code == 429
    finally:
        store.close()
