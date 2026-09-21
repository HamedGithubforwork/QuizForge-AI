"""Owned background uploads for the opt-in single-host deployment."""
import asyncio
from contextlib import suppress
from datetime import datetime, timezone
import os
import json
import time
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from app_shared import AuthenticatedUser, get_current_user
from document_api import UploadResponse, build_upload_response_from_sha
from observability import log_event
from pdf_job_store import JobStore, MAX_UPLOAD_BYTES
from pdf_process import extract_background
from pdf_selection import parse_selection

_manager = None
router = APIRouter(prefix='/api/documents/jobs')


class PdfJobResponse(BaseModel):
    job_id: str
    filename: str
    status: Literal['queued', 'processing', 'succeeded', 'failed', 'cancelled']
    completed_pages: int
    total_pages: int | None
    expires_at: str
    error: str | None
    result: UploadResponse | None = None
    selected_pages: list[int] = Field(default_factory=list)
    source_sha256: str | None = None
    reused_pages: int = 0


class PdfJobList(BaseModel):
    jobs: list[PdfJobResponse]
    supports_page_selection: bool = True
    supports_page_reuse: bool = True


def enabled():
    return os.getenv('PDF_BACKGROUND_JOBS') == 'true'


async def store_call(function, *args):
    # A cancelled coroutine must not leave a database thread running after the
    # singleton worker lock is released during shutdown.
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        with suppress(Exception):
            await task
        raise


def public_job(row):
    pages = row.get('result')
    return PdfJobResponse(
        job_id=row['id'], filename=row['filename'], status=row['state'],
        completed_pages=row['completed_pages'], total_pages=row['total_pages'],
        selected_pages=json.loads(row.get('selection', '[]')),
        source_sha256=row.get('source_sha256') or None, reused_pages=row.get('reused_pages', 0),
        expires_at=datetime.fromtimestamp(row['expires'], timezone.utc).isoformat(), error=row['error'],
        result=build_upload_response_from_sha(filename=row['filename'], pdf_sha256=row['sha256'], pages=pages)
        if pages is not None and row['state'] == 'succeeded' else None,
    )


class JobManager:
    def __init__(self, store):
        self.store = store
        self.task = None
        self.active = None
        self.active_id = None
        self.uploads = 0
        self.closing = False

    async def start(self):
        self.task = asyncio.create_task(self.run(), name='pdf-background-queue')

    async def stop(self):
        self.closing = True
        if self.task is not None:
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task
        await store_call(self.store.close)

    async def run(self):
        try:
            while True:
                row = await store_call(self.store.claim)
                if row is None:
                    await asyncio.sleep(1)
                    continue
                self.active_id = row['id']
                self.active = asyncio.create_task(self.process(row))
                try:
                    await self.active
                except asyncio.CancelledError:
                    if self.closing:
                        raise
                finally:
                    self.active = None
                    self.active_id = None
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Never include a filename, document content, token or SQLite error text.
            log_event('pdf_queue_unavailable', error_type=type(error).__name__)

    async def process(self, row):
        async def checkpoint(pages, total):
            await store_call(self.store.checkpoint, row['id'], pages, total)
        try:
            timeout = min(600, max(0.01, row['expires'] - time.time()))
            pages = await extract_background(row['input'], timeout=timeout,
                                             checkpoint=row['checkpoint'], on_checkpoint=checkpoint,
                                             page_numbers=json.loads(row['selection']))
            await store_call(self.store.finish, row['id'], pages)
        except HTTPException as error:
            await store_call(self.store.fail, row['id'], error.detail)
        except Exception:
            await store_call(self.store.fail, row['id'], 'PDF processing failed. Please try again later.')

    async def submit_upload(self, owner, file, page_selection=''):
        # Bound in-memory body reads; the reverse proxy must also bound the
        # incoming multipart body and simultaneous uploads before ASGI parsing.
        if self.uploads >= 2:
            raise HTTPException(429, 'Uploads are busy. Try again shortly.', headers={'Retry-After': '10'})
        self.uploads += 1
        try:
            try:
                selected = parse_selection(page_selection)
            except ValueError as error:
                raise HTTPException(400, str(error)) from None
            contents = await file.read(MAX_UPLOAD_BYTES + 1)
            row = await store_call(self.store.submit, owner, file.filename, contents, selected)
            if row['state'] == 'succeeded':
                row = await store_call(self.store.get_owned, owner, row['id'])
            return public_job(row)
        finally:
            self.uploads -= 1


def manager():
    if not enabled():
        raise HTTPException(404, 'Background PDF processing is not enabled.')
    if _manager is None or _manager.task.done():
        raise HTTPException(503, 'PDF processing is temporarily unavailable.')
    return _manager


async def start_pdf_jobs():
    global _manager
    if not enabled():
        return
    if os.getenv('PDF_PROCESS_ISOLATION') != 'true' or not os.getenv('PDF_JOB_DIR'):
        raise RuntimeError('Background PDFs require isolated processing and a private persistent PDF_JOB_DIR')
    store = await store_call(JobStore, os.environ['PDF_JOB_DIR'])
    _manager = JobManager(store)
    await _manager.start()


async def close_pdf_jobs():
    global _manager
    if _manager is not None:
        current = _manager
        _manager = None
        await current.stop()


async def get_durable_document(owner, sha256):
    if not enabled():
        return None
    current = manager()
    return await store_call(current.store.get_document, owner, sha256)


@router.get('', response_model=PdfJobList)
async def list_jobs(response: Response, current_user: AuthenticatedUser = Depends(get_current_user)):
    response.headers['Cache-Control'] = 'no-store'
    current = manager()
    rows = await store_call(current.store.list_owned, current_user.id)
    return PdfJobList(jobs=[public_job(row) for row in rows])


@router.get('/{job_id}', response_model=PdfJobResponse)
async def get_job(job_id: UUID, response: Response, current_user: AuthenticatedUser = Depends(get_current_user)):
    response.headers['Cache-Control'] = 'no-store'
    current = manager()
    return public_job(await store_call(current.store.get_owned, current_user.id, str(job_id)))


@router.delete('/{job_id}', status_code=204)
async def cancel_job(job_id: UUID, current_user: AuthenticatedUser = Depends(get_current_user)):
    current = manager()
    await store_call(current.store.cancel, current_user.id, str(job_id))
    if current.active_id == str(job_id) and current.active is not None:
        current.active.cancel()
        with suppress(asyncio.CancelledError):
            await current.active
    return Response(status_code=204, headers={'Cache-Control': 'no-store'})
