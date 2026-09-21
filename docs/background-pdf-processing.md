# Background PDF processing for the small AWS server

This opt-in candidate addresses the 30-page scan that exceeded the synchronous
120-second deadline during the 2 GiB / 0.4 CPU capacity simulation. It does not
deploy a server, migrate an account, make model calls or change domain routing.

## Website and API behavior

With `PDF_BACKGROUND_JOBS=true`, authenticated `POST /api/documents/upload`
commits the upload to a private durable queue and returns **202** with a job ID.
The website polls the owned job every two seconds and shows completed page counts.
It can resume a recent PDF after a reload, including generating a quiz and reading
source pages without uploading the original file again. Closing the page stops
browser polling; **Cancel and discard PDF** explicitly cancels server processing.

- `GET /api/documents/jobs` lists only the authenticated owner's retained jobs.
- `GET /api/documents/jobs/{id}` returns status and, on success, the existing
  lightweight upload result. Full page text is never included in job summaries.
- `DELETE /api/documents/jobs/{id}` cancels/discards that owner's job and returns
  204. Unknown, expired and other-owner IDs produce the same 404.
- Results are retrieved for quiz generation/source pages by both verified owner
  and document hash. Client-supplied ownership fields are not accepted.
- Job responses use `Cache-Control: no-store`; no PDF or job is saved in browser
  storage. A change of signed-in Supabase user resets the app's upload state.

Without the flag, the existing synchronous upload contract remains HTTP 200.
When background mode is enabled, uploading a PDF to quiz generation cannot bypass
the queue: an unprocessed document receives 409 and must be processed first.

## Selecting pages before extraction

The background upload form accepts an optional `page_selection` such as `2, 5-7`.
Blank means all pages. Selection is validated and canonicalized before admission;
the worker reads/rasterizes/OCRs only those pages and preserves their original
page numbers in saved text, checkpoints, previews, citations and weak-area practice.
Out-of-document selections return a job error. The original PDF must still be at
most 100 pages and 15 MiB; the 30-scan limit applies to the pages being processed.
The whole file is uploaded, so this reduces processing rather than upload bandwidth.

Partial-document identity includes both the raw PDF hash and canonical selection.
The existing `pdf_sha256` response field therefore identifies the selected view for
partial uploads; clients must reuse that returned value. Full-document hashes remain
unchanged. Different selections cannot reuse incompatible text, quiz or history
results. Exact job hits require the same owner, PDF, selection and extraction version. Synchronous legacy
uploads reject nonempty selections explicitly; the website displays the control
only when job discovery explicitly advertises `supports_page_selection: true`,
so a newer frontend cannot silently submit a selection to an older backend.

## Changing pages after processing

**Change pages** opens a separate form after success. Applying a valid selection
replaces the document and resets its quiz; a failed or cancelled change preserves
the previous document and quiz. Blank selects all pages. Generation, review and
save operations disable page changes, and the edit form pauses quiz actions.
The original `File` remains only in browser memory while the page is open. After
refresh/resume the form asks for the original PDF again and checks its SHA-256
before submitting, so a same-name replacement cannot silently switch documents.
The whole PDF is uploaded again; the server still deletes raw bytes on completion.

Jobs expose `source_sha256` (the raw file hash) and `reused_pages`. The list response
advertises `supports_page_reuse: true`; the button requires that capability and a
source hash. Older retained jobs without a source hash remain resumable.

New selections seed their private checkpoints from completed results for the same
verified owner, raw file hash and extraction version. For example, processing
1–10 followed by 5–15 reuses 5–10 and OCRs only 11–15. Sparse checkpoints keep
original numbers, survive restart and accept only the next missing pages in order.
The worker still preflights PDF/page/scan limits, even when every page is cached.
No separate unbounded page cache is introduced: source results remain subject to
the existing 32 MiB LRU cache; seeded text fits the job's 8 MiB reservation.
Changed selections count against the existing admission limits.

To avoid retaining old text indefinitely through repeated selections, a result
that reuses pages expires no later than the earliest contributing cached result.
Only sources with more than one hour remaining seed a new job, keeping reused
text valid through the entire pending-job lifetime. Near-expiry pages are processed
again. Bump `EXTRACTION_VERSION` when OCR/preprocessing behavior changes.

## Bounds and recovery

One PDF subprocess runs at a time. At most four jobs may be queued/running across
the host, with one pending job per owner and four new jobs per owner per hour.
Duplicate submissions of an unexpired pending/completed PDF reuse the same owned
job, including after a lost HTTP response. At most sixteen job records and
128 MiB of reserved input/checkpoint/result payload are retained. Completed text
has a separate 32 MiB cap, with least-recently-used completed results evicted
when needed. Admissions are tracked independently for one hour (four per owner,
sixteen globally), so eviction and cancellation cannot reset upload allowances. Pending jobs
reserve their input size plus 8 MiB for completed page text. Busy submissions receive
429 with Retry-After; a stopped queue fails closed with 503.

The existing 15 MiB file, 100 total pages, 30 scanned pages, page-dimension,
8 MiB result and 768 MiB worker address-space limits remain. The child retains its
90-second soft / 95-second hard CPU-time limit. A background job has a separate
600-second wall deadline; it does not hold an HTTP request for that duration.
The synchronous worker deadline is still 120 seconds. Timed-out/cancelled workers
are killed and reaped. Linux parent-death signaling also kills the worker when
the API process dies. This is resource isolation, not a complete malicious-file
sandbox.

SQLite transactions with full synchronization commit the input before acceptance.
The singleton worker holds an OS file lock, so a second API process using the same
directory cannot start another queue. Each completed OCR page is committed with
its progress count in the same transaction. Selectable pages are batched to avoid
one disk synchronization per page. On restart, interrupted jobs are retried
once from those saved pages, without recognizing them again; a second interruption
ends the job with an explicit failure. Completed
results remain usable across a process restart and a Redis cache miss.

Saved page text stays private and is unavailable through the document API until
the entire extraction succeeds. Checkpoints are removed after success, failure,
cancellation or expiration. Raw input is removed after success, failure or cancellation. All processing
jobs expire one hour after submission. Successful extracted text expires at most 24 hours
after completion (earlier when reusing pages), without extending its expiry on reads; it may be evicted earlier
under the cache bounds. Raw PDFs are never retained for the extended cache window.
Reads enforce expiration
immediately and the queue loop removes expired records, including at startup.
SQLite secure deletion clears deleted payload from ordinary database pages;
encrypted storage is still necessary for the host and any storage snapshots.

## Deployment requirements

Set `PDF_BACKGROUND_JOBS=true`, `PDF_PROCESS_ISOLATION=true` and an absolute
`PDF_JOB_DIR` on a private persistent Linux volume. The directory must be owned
by the API user with mode 0700; database files are mode 0600. Use exactly one
Uvicorn worker and the same mounted directory across container replacements.
Do not use an ephemeral container layer or a shared/network filesystem. The
SQLite main file is capped at 256 MiB; allow additional space for its transient
rollback journal. Exclude temporary PDF jobs from retained application backups.
Account/history backups remain a separate required operation.

Queue schema version 4 migrates versions 1, 2 and 3 on startup while preserving
uploads, checkpoints, existing expiry times and recent admission counts.
Older completed jobs without source hashes/version metadata do not seed new selections.
Version-1 interrupted jobs have no saved page text and therefore restart from
page one. Drain/discard temporary jobs before rolling back to an older application
that only understands an older queue schema.

The isolated worker extracts selectable text once and initializes one Tesseract 5
engine per document. It recognizes 150-DPI grayscale page rasters directly, avoiding
intermediate searchable PDFs and repeated language-model loading. Native work
remains inside the limited child with no API, database or model-client imports.
The production image must provide `libtesseract.so.5` and English trained data;
the existing Tesseract package installation supplies them.

The reverse proxy must enforce the 16 MiB multipart-body ceiling, upload
connection/rate limits and request timeouts before ASGI parses incoming files.
The API also limits concurrent in-memory upload reads to two. A host failure can
require reuploading temporary PDFs; do not promise cross-host queue recovery.
Deploy only with the separately reviewed self-hosted database profile, existing
authentication, model budgets, backups and restore procedures. This queue does
not replace those migration requirements.

## Verification

Tests exercise verified signed-token ownership, 202 admission and document resume,
cross-owner status/cancel/source rejection, concurrent admission, idempotency,
hourly allowance, expiration, raw/result deletion, single-worker locking, bounded
restart recovery, real child cancellation and cancellation during process creation.
Checkpoint tests cover atomic progress, bounds, private reads, version-1 migration,
page skipping on resume and deletion of saved bytes for every terminal state.
The required Docker OCR check exercises small text, columns, mixed content and
PDF rotation metadata through the real isolated worker, including interrupted resume.
Browser tests cover progress, page refresh, restored quiz generation, page selection
and cancellation, plus changed selections, failed changes, wrong-file rejection,
refresh/reupload, updated quiz identity and mobile form accessibility. Cache tests cover fixed 24-hour expiry, LRU byte bounds, private
reads, migration and admission limits that survive eviction.
The follow-up constrained capacity run must measure admission latency separately
from background completion and retain the original failed synchronous result.

Implementation references: [Python subprocess lifecycle](https://docs.python.org/3.11/library/asyncio-subprocess.html)
and [SQLite secure deletion](https://www.sqlite.org/pragma.html#pragma_secure_delete).
