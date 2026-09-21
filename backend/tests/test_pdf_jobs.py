import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import sqlite3
import sys
import time
from uuid import UUID

from fastapi import HTTPException
import httpx
import pymupdf
import pytest

import app_shared
from main import app
import pdf_jobs
from pdf_job_store import JobStore
import processed_documents

pytestmark = pytest.mark.skipif(sys.platform != 'linux', reason='The single-host PDF queue requires Linux')


def pdf_bytes():
    with pymupdf.open() as document:
        for _ in range(2):
            page = document.new_page()
            page.insert_textbox(pymupdf.Rect(40, 40, 550, 500), 'Photosynthesis converts light into stored chemical energy. ' * 8)
        return document.tobytes()


def test_durable_ownership_idempotency_concurrent_admission_and_private_files(tmp_path):
    store = JobStore(tmp_path / 'queue')
    try:
        with pytest.raises(BlockingIOError):
            JobStore(tmp_path / 'queue')
        def submit(index):
            try:
                return store.submit('owner-' + str(index), 'notes.pdf', b'unique-private-synthetic-input')
            except HTTPException as error:
                return error.status_code
        with ThreadPoolExecutor(max_workers=5) as pool:
            outcomes = list(pool.map(submit, range(5)))
        assert sum(isinstance(item, dict) for item in outcomes) == 4
        assert outcomes.count(429) == 1
        row = next(item for item in outcomes if isinstance(item, dict))
        assert store.submit(row['owner'], 'renamed.pdf', b'unique-private-synthetic-input')['id'] == row['id']
        for method in (store.get_owned, store.cancel):
            with pytest.raises(HTTPException) as error:
                method('different-owner', row['id'])
            assert error.value.status_code == 404
        with pytest.raises(HTTPException) as error:
            store.submit(row['owner'], 'different.pdf', b'different-input')
        assert error.value.status_code == 429
        assert os.stat(store.path).st_mode & 0o077 == 0
        assert os.stat(store.path.parent).st_mode & 0o077 == 0
    finally:
        store.close()


def test_recovery_is_bounded_and_discard_removes_raw_and_result_bytes(tmp_path):
    directory = tmp_path / 'queue'
    store = JobStore(directory)
    raw = b'PRIVATE-SYNTHETIC-PDF-CONTENT-8379205'
    row = store.submit('alice', 'private.pdf', raw)
    assert store.claim()['id'] == row['id']
    store.close()
    store = JobStore(directory)
    try:
        recovered = store.get_owned('alice', row['id'])
        assert recovered['state'] == 'queued' and recovered['attempts'] == 1
        assert store.claim()['input'] == raw
        store.recover()
        failed = store.get_owned('alice', row['id'])
        assert failed['state'] == 'failed' and failed['attempts'] == 2
        with sqlite3.connect(store.path) as db:
            assert db.execute('SELECT input,result,reserved FROM jobs').fetchone() == (None, None, 0)
        assert raw not in store.path.read_bytes()

        row = store.submit('bob', 'notes.pdf', raw)
        store.claim()
        store.finish(row['id'], [{'page_number': 1, 'text': raw.decode()}])
        assert store.get_document('bob', hashlib.sha256(raw).hexdigest()) is not None
        assert store.get_document('alice', hashlib.sha256(raw).hexdigest()) is None
        store.cancel('bob', row['id'])
        assert store.get_document('bob', hashlib.sha256(raw).hexdigest()) is None
        assert raw not in store.path.read_bytes()
    finally:
        store.close()


def test_expiry_and_hourly_allowance_do_not_accumulate_payloads(tmp_path, monkeypatch):
    store = JobStore(tmp_path / 'queue')
    now = time.time()
    try:
        for index in range(4):
            row = store.submit('alice', 'notes.pdf', str(index).encode())
            store.cancel('alice', row['id'])
        with pytest.raises(HTTPException) as error:
            store.submit('alice', 'notes.pdf', b'fifth')
        assert error.value.status_code == 429
        monkeypatch.setattr('pdf_job_store.time.time', lambda: now + 3601)
        assert store.list_owned('alice') == []
        with pytest.raises(HTTPException) as error:
            store.get_owned('alice', row['id'])
        assert error.value.status_code == 404
        store.cleanup()
        with sqlite3.connect(store.path) as db:
            assert db.execute('SELECT count(*) FROM jobs').fetchone()[0] == 0
        assert store.submit('alice', 'notes.pdf', b'next-hour')['state'] == 'queued'
    finally:
        store.close()


@pytest.mark.parametrize('selection,numbers', [('', [1, 2]), ('2', [2])])
def test_real_api_uses_verified_owner_and_recovers_document_without_memory_cache(tmp_path, monkeypatch, cognito, selection, numbers):
    async def scenario():
        monkeypatch.setenv('PDF_BACKGROUND_JOBS', 'true')
        monkeypatch.setenv('PDF_PROCESS_ISOLATION', 'true')
        monkeypatch.setenv('PDF_JOB_DIR', str(tmp_path / 'queue'))
        async def cache_miss(*_args): return None
        monkeypatch.setattr(processed_documents, 'get_cached_document', cache_miss)
        async def source_miss(*_args): return ('unseeded', None)
        monkeypatch.setattr(processed_documents, 'get_cached_source_page', source_miss)
        async with httpx.AsyncClient(transport=httpx.MockTransport(cognito.handler), trust_env=False) as identity:
            async def identity_client(): return identity
            monkeypatch.setattr(app_shared, 'get_http_client', identity_client)
            await pdf_jobs.start_pdf_jobs()
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test', trust_env=False) as client:
                    assert (await client.get('/api/documents/jobs')).status_code == 401
                    token = {'Authorization': 'Bearer ' + cognito.sign()}
                    other = {'Authorization': 'Bearer ' + cognito.sign(subject=str(UUID(int=202)))}
                    raw = pdf_bytes()
                    response = await client.post('/api/documents/upload', headers=token,
                                                 data={'page_selection': selection},
                                                 files={'file': ('notes.pdf', raw, 'application/pdf')})
                    assert response.status_code == 202 and response.headers['Cache-Control'] == 'no-store'
                    job = response.json()
                    path = '/api/documents/jobs/' + job['job_id']
                    assert (await client.get(path, headers=other)).status_code == 404
                    assert (await client.delete(path, headers=other)).status_code == 404
                    assert (await client.get('/api/documents/jobs', headers=other)).json() == {'jobs': [], 'supports_page_selection': True, 'supports_page_reuse': True}
                    for _ in range(150):
                        job = (await client.get(path, headers=token)).json()
                        if job['status'] == 'succeeded': break
                        assert job['status'] in ('queued', 'processing'), job
                        await asyncio.sleep(.05)
                    assert job['status'] == 'succeeded' and job['completed_pages'] == len(numbers)
                    assert [page['page_number'] for page in job['result']['pages']] == numbers
                    assert job['selected_pages'] == (numbers if selection else [])
                    assert 'input' not in job and 'text' not in job['result']['pages'][0]
                    assert job['source_sha256'] == hashlib.sha256(raw).hexdigest()
                    assert job['reused_pages'] == 0
                    if selection:
                        changed = await client.post('/api/documents/upload', headers=token,
                            data={'page_selection': '1-2'}, files={'file': ('renamed.pdf', raw, 'application/pdf')})
                        assert changed.status_code == 202
                        changed_job = changed.json()
                        assert changed_job['reused_pages'] == 1
                        changed_path = '/api/documents/jobs/' + changed_job['job_id']
                        for _ in range(150):
                            changed_job = (await client.get(changed_path, headers=token)).json()
                            if changed_job['status'] == 'succeeded': break
                            assert changed_job['status'] in ('queued', 'processing'), changed_job
                            await asyncio.sleep(.05)
                        assert changed_job['status'] == 'succeeded'
                        assert [page['page_number'] for page in changed_job['result']['pages']] == [1, 2]
                        assert changed_job['result']['pdf_sha256'] != job['result']['pdf_sha256']
                        assert (await client.get(changed_path, headers=other)).status_code == 404
                        assert (await client.delete(changed_path, headers=token)).status_code == 204
                    digest = job['result']['pdf_sha256']
                    await pdf_jobs.close_pdf_jobs()
                    processed_documents._memory_documents.clear()
                    await pdf_jobs.start_pdf_jobs()
                    restored = (await client.get(path, headers=token)).json()
                    assert restored['result'] == job['result']
                    source = f'/api/documents/{digest}/pages/{numbers[0]}'
                    own_source = await client.get(source, headers=token)
                    assert own_source.status_code == 200 and 'Photosynthesis' in own_source.json()['text']
                    if selection:
                        assert (await client.get(f'/api/documents/{digest}/pages/1', headers=token)).status_code == 404
                    assert (await client.get(source, headers=other)).status_code == 410
                    assert (await client.delete(path, headers=token)).status_code == 204
                    assert (await client.get(path, headers=token)).json()['status'] == 'cancelled'
                    assert (await client.get(source, headers=token)).status_code == 410
            finally:
                await pdf_jobs.close_pdf_jobs()
    asyncio.run(scenario())


def test_cancel_running_job_kills_real_child_and_queue_continues(tmp_path, monkeypatch):
    async def scenario():
        import pdf_process
        children = []
        original = asyncio.create_subprocess_exec
        async def slow(*args, **kwargs):
            child = await original(sys.executable, '-c', 'import time; time.sleep(30)', **kwargs)
            children.append(child)
            return child
        monkeypatch.setenv('PDF_BACKGROUND_JOBS', 'true')
        monkeypatch.setenv('PDF_PROCESS_ISOLATION', 'true')
        monkeypatch.setenv('PDF_JOB_DIR', str(tmp_path / 'queue'))
        monkeypatch.setattr(asyncio, 'create_subprocess_exec', slow)
        await pdf_jobs.start_pdf_jobs()
        manager = pdf_jobs.manager()
        try:
            row = await pdf_jobs.store_call(manager.store.submit, 'alice', 'notes.pdf', pdf_bytes())
            for _ in range(200):
                if children: break
                await asyncio.sleep(.01)
            assert children
            await pdf_jobs.cancel_job(UUID(row['id']), app_shared.AuthenticatedUser(id='alice'))
            assert children[0].returncode is not None
            assert manager.store.get_owned('alice', row['id'])['state'] == 'cancelled'
            monkeypatch.setattr(asyncio, 'create_subprocess_exec', original)
            next_row = await pdf_jobs.store_call(manager.store.submit, 'alice', 'retry.pdf', pdf_bytes())
            for _ in range(200):
                result = await pdf_jobs.store_call(manager.store.get_owned, 'alice', next_row['id'])
                if result['state'] == 'succeeded': break
                await asyncio.sleep(.05)
            assert result['state'] == 'succeeded'
        finally:
            await pdf_jobs.close_pdf_jobs()
    asyncio.run(scenario())


def test_cancellation_during_child_creation_does_not_orphan_worker(monkeypatch):
    async def scenario():
        import pdf_process
        original = asyncio.create_subprocess_exec
        children = []
        created = asyncio.Event()
        release = asyncio.Event()
        async def delayed(*args, **kwargs):
            child = await original(sys.executable, '-c', 'import time; time.sleep(30)', **kwargs)
            children.append(child)
            created.set()
            await release.wait()
            return child
        monkeypatch.setattr(asyncio, 'create_subprocess_exec', delayed)
        task = asyncio.create_task(pdf_process.extract_in_process(b'pdf'))
        await created.wait()
        task.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError): await task
        assert children[0].returncode is not None
    asyncio.run(scenario())
