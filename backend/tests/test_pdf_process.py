import asyncio
import sys

import pymupdf
import pytest
from fastapi import HTTPException

import pdf_process

pytestmark = pytest.mark.skipif(sys.platform != 'linux', reason='The small AWS server is Linux')


def make_pdf(pages=1):
    with pymupdf.open() as document:
        for _ in range(pages):
            page = document.new_page()
            page.insert_textbox(pymupdf.Rect(40, 40, 550, 500),
                                'QuizForge capacity verification. Photosynthesis produces glucose and oxygen. ' * 4)
        return document.tobytes()


def test_real_subprocess_extracts_text_and_preserves_user_errors():
    async def scenario():
        result = await pdf_process.extract_in_process(make_pdf())
        assert len(result) == 1 and 'Photosynthesis' in result[0]['text']
        for raw, status in ((b'invalid pdf', 400), (make_pdf(101), 413)):
            with pytest.raises(HTTPException) as error:
                await pdf_process.extract_in_process(raw)
            assert error.value.status_code == status
    asyncio.run(scenario())


def test_queue_is_bounded_and_cancellation_releases_its_slot(monkeypatch):
    async def scenario():
        entered = asyncio.Event()
        release = asyncio.Event()
        async def blocked(_):
            entered.set()
            await release.wait()
            return []
        monkeypatch.setattr(pdf_process, '_execute', blocked)
        first = asyncio.create_task(pdf_process.extract_in_process(b'a'))
        await entered.wait()
        second = asyncio.create_task(pdf_process.extract_in_process(b'b'))
        await asyncio.sleep(0)
        with pytest.raises(HTTPException) as error:
            await pdf_process.extract_in_process(b'c')
        assert error.value.status_code == 429
        second.cancel()
        with pytest.raises(asyncio.CancelledError):
            await second
        release.set()
        await first
        assert await pdf_process.extract_in_process(b'd') == []
    asyncio.run(scenario())


def test_real_worker_is_killed_on_timeout_and_next_request_can_run(monkeypatch):
    async def scenario():
        original_create = asyncio.create_subprocess_exec
        children = []
        async def slow_worker(*args, **kwargs):
            child = await original_create(sys.executable, '-c', 'import time; time.sleep(30)', **kwargs)
            children.append(child)
            return child
        monkeypatch.setattr(asyncio, 'create_subprocess_exec', slow_worker)
        monkeypatch.setattr(pdf_process, 'TIMEOUT_SECONDS', .05)
        with pytest.raises(HTTPException) as error:
            await pdf_process.extract_in_process(b'a')
        assert error.value.status_code == 503 and children[0].returncode is not None
        monkeypatch.setattr(asyncio, 'create_subprocess_exec', original_create)
        monkeypatch.setattr(pdf_process, 'TIMEOUT_SECONDS', 120)
        assert await pdf_process.extract_in_process(make_pdf())
    asyncio.run(scenario())
