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
from pdf_protocol import MAX_RESULT_BYTES, validate_pages
from pdf_selection import validate_selection

TIMEOUT_SECONDS = 120
_states = weakref.WeakKeyDictionary()


class _State:
    def __init__(self):
        self.active = asyncio.Lock()
        self.pending = 0


async def _execute(contents, *, timeout=None, on_progress=None, checkpoint=None, on_checkpoint=None, page_numbers=None):
    selected = [] if page_numbers is None else validate_selection(page_numbers)
    saved = [] if checkpoint is None else checkpoint
    resume = validate_pages(saved, total=len(selected) if selected else 100, page_numbers=selected)
    previous = len(saved)
    expected_total = None
    progress_mode = on_progress is not None or on_checkpoint is not None
    if saved and not progress_mode:
        raise ValueError('Checkpoints require progress mode')
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TESSDATA_PREFIX') if key in os.environ}
    env.update(OMP_THREAD_LIMIT='1', PYTHONDONTWRITEBYTECODE='1', PYTHONUNBUFFERED='1',
               PDF_WORKER_PARENT_PID=str(os.getpid()))
    creation = asyncio.create_task(asyncio.create_subprocess_exec(
        sys.executable, str(Path(__file__).with_name('pdf_worker.py')),
        *(['--progress', '--resume'] if progress_mode else []),
        *(['--pages', ','.join(map(str, selected))] if selected else []),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, env=env, limit=MAX_RESULT_BYTES + 4096,
    ))
    process = None
    try:
        # Shield creation so cancellation cannot lose the child before it is
        # assigned and reaped. The child also exits if this parent dies.
        process = await asyncio.shield(creation)

        async def exchange():
            nonlocal previous, expected_total
            if not progress_mode:
                raw, _ = await process.communicate(contents)
                return raw
            async def send():
                try:
                    process.stdin.write(len(resume).to_bytes(4, 'big'))
                    process.stdin.write(resume)
                    process.stdin.write(contents)
                    await process.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    process.stdin.close()
            writer = asyncio.create_task(send())
            received = 0
            page_bytes = len(resume)
            result = None
            try:
                while line := await process.stdout.readline():
                    received += len(line)
                    # Each completed page is sent once, then once in the result.
                    if received > 2 * MAX_RESULT_BYTES + 32_768:
                        raise ValueError('Worker output exceeded its bound')
                    item = json.loads(line)
                    if result is not None:
                        raise ValueError('Output after worker result')
                    if item.get('type') == 'pages':
                        batch, total = item['pages'], item['total']
                        encoded = validate_pages(batch, start=previous + 1, total=total, page_numbers=selected)
                        if not batch or (expected_total is not None and total != expected_total):
                            raise ValueError('Invalid worker progress')
                        expected_total = total
                        page_bytes += len(encoded)
                        if page_bytes > MAX_RESULT_BYTES:
                            raise ValueError('Worker checkpoint exceeded its bound')
                        if on_checkpoint is not None:
                            await on_checkpoint(batch, total)
                        previous += len(batch)
                        if on_progress is not None:
                            await on_progress(previous, total)
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
        except (ValueError, KeyError, TypeError, AttributeError):
            raise HTTPException(503, 'PDF processing is temporarily unavailable.') from None
        if process.returncode != 0 or len(raw) > MAX_RESULT_BYTES:
            raise HTTPException(503, 'PDF processing exceeded available capacity. Try a smaller document.')
        try:
            result = json.loads(raw)
            if result['status'] != 200:
                raise HTTPException(result['status'], result['detail'])
            validate_pages(result['pages'], total=len(selected) if selected else 100, page_numbers=selected)
            if selected and len(result['pages']) != len(selected):
                raise ValueError('Worker omitted selected pages')
            if progress_mode and (len(result['pages']) != previous
                    or (expected_total is not None and previous != expected_total)):
                raise ValueError('Worker result did not match completed pages')
            return result['pages']
        except (ValueError, KeyError, TypeError, AttributeError):
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


async def extract_background(contents, on_progress=None, *, timeout=600, checkpoint=None, on_checkpoint=None, page_numbers=None):
    # The durable queue owns admission and the single active job. Synchronous
    # extraction routes are disabled when background mode is enabled.
    if len(contents) > 15 * 1024**2:
        raise HTTPException(413, 'PDF exceeds the 15 MB upload limit.')
    return await _execute(contents, timeout=timeout, on_progress=on_progress,
                          checkpoint=checkpoint, on_checkpoint=on_checkpoint, page_numbers=page_numbers)


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
