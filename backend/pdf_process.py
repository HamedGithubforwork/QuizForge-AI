"""Opt-in bounded PDF subprocess for a small single-worker API deployment.

Native OCR must not monopolize the API interpreter. One active extraction and
one waiting request are allowed per API process. The deployment must use one
Uvicorn worker. Child limits isolate failures; they are not an OS security sandbox.
"""
import asyncio
import json
import os
from pathlib import Path
import sys
import weakref

from fastapi import HTTPException

TIMEOUT_SECONDS = 120
MAX_RESULT_BYTES = 8 * 1024 * 1024
_states = weakref.WeakKeyDictionary()


class _State:
    def __init__(self):
        self.active = asyncio.Lock()
        self.pending = 0


async def _execute(contents):
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TESSDATA_PREFIX') if key in os.environ}
    env.update(OMP_THREAD_LIMIT='1', PYTHONDONTWRITEBYTECODE='1', PYTHONUNBUFFERED='1')
    process = await asyncio.create_subprocess_exec(
        sys.executable, str(Path(__file__).with_name('pdf_worker.py')),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, env=env,
    )
    try:
        try:
            raw, _ = await asyncio.wait_for(process.communicate(contents), TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            raise HTTPException(503, 'PDF processing took too long. Try a smaller document.') from None
        if process.returncode != 0 or len(raw) > MAX_RESULT_BYTES:
            raise HTTPException(503, 'PDF processing exceeded available capacity. Try a smaller document.')
        try:
            result = json.loads(raw)
            if result['status'] != 200:
                raise HTTPException(result['status'], result['detail'])
            return result['pages']
        except (ValueError, KeyError, TypeError):
            raise HTTPException(503, 'PDF processing is temporarily unavailable.') from None
    finally:
        if process.returncode is None:
            process.kill()
        await process.wait()


async def extract_in_process(contents):
    if len(contents) > 15 * 1024 * 1024:
        raise HTTPException(413, 'PDF exceeds the 15 MB upload limit.')
    loop = asyncio.get_running_loop()
    state = _states.setdefault(loop, _State())
    # No await between checking and incrementing: atomic on this event loop.
    if state.pending >= 2:
        raise HTTPException(429, 'Two PDFs are already being processed. Try again shortly.',
                            headers={'Retry-After': '10'})
    state.pending += 1
    acquired = False
    try:
        try:
            await asyncio.wait_for(state.active.acquire(), TIMEOUT_SECONDS)
            acquired = True
        except asyncio.TimeoutError:
            raise HTTPException(429, 'PDF processing is busy. Try again shortly.',
                                headers={'Retry-After': '10'}) from None
        return await _execute(contents)
    finally:
        if acquired:
            state.active.release()
        state.pending -= 1
