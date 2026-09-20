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


async def _execute(contents, *, timeout=None, on_progress=None):
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TESSDATA_PREFIX') if key in os.environ}
    env.update(OMP_THREAD_LIMIT='1', PYTHONDONTWRITEBYTECODE='1', PYTHONUNBUFFERED='1',
               PDF_WORKER_PARENT_PID=str(os.getpid()))
    creation = asyncio.create_task(asyncio.create_subprocess_exec(
        sys.executable, str(Path(__file__).with_name('pdf_worker.py')),
        *(['--progress'] if on_progress else []),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, env=env, limit=MAX_RESULT_BYTES + 4096,
    ))
    process = None
    try:
        # Shield creation so cancellation cannot lose the child before it is
        # assigned and reaped. The child also exits if this parent dies.
        process = await asyncio.shield(creation)

        async def exchange():
            if on_progress is None:
                raw, _ = await process.communicate(contents)
                return raw
            async def send():
                try:
                    process.stdin.write(contents)
                    await process.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    process.stdin.close()
            writer = asyncio.create_task(send())
            received = 0
            previous = 0
            result = None
            try:
                while line := await process.stdout.readline():
                    received += len(line)
                    if received > MAX_RESULT_BYTES + 32_768:
                        raise ValueError('Worker output exceeded its bound')
                    item = json.loads(line)
                    if item.get('type') == 'progress':
                        completed, total = item['completed'], item['total']
                        if type(completed) is not int or type(total) is not int or not previous <= completed <= total <= 100:
                            raise ValueError('Invalid worker progress')
                        previous = completed
                        await on_progress(completed, total)
                    elif item.get('type') == 'result' and result is None:
                        result = line
                    else:
                        raise ValueError('Invalid worker protocol')
                await writer
                await process.wait()
                if result is None:
                    raise ValueError('Missing worker result')
                return result
            finally:
                if not writer.done():
                    writer.cancel()
                try:
                    await writer
                except asyncio.CancelledError:
                    pass

        try:
            raw = await asyncio.wait_for(exchange(), TIMEOUT_SECONDS if timeout is None else timeout)
        except asyncio.TimeoutError:
            raise HTTPException(503, 'PDF processing took too long. Try a smaller document.') from None
        except (ValueError, KeyError, TypeError):
            raise HTTPException(503, 'PDF processing is temporarily unavailable.') from None
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
        if process is None:
            process = await creation
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await process.wait()


async def extract_background(contents, on_progress, *, timeout=600):
    # The durable queue owns admission and the single active job. Synchronous
    # extraction routes are disabled when background mode is enabled.
    if len(contents) > 15 * 1024**2:
        raise HTTPException(413, 'PDF exceeds the 15 MB upload limit.')
    return await _execute(contents, timeout=timeout, on_progress=on_progress)


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
