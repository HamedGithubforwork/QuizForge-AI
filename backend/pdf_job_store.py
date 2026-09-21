"""Bounded, single-host PDF queue. All calls run outside the API event loop.

The directory must be a private persistent volume. SQLite commits the upload
before 202 is returned; raw bytes are removed on completion/cancellation/failure.
This database is temporary processing data, not an account/history database.
"""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import time
from uuid import uuid4

from fastapi import HTTPException
from pdf_protocol import MAX_PAGE_BYTES, validate_pages, validate_checkpoint, validate_next_pages
from pdf_selection import selection_identity, validate_selection

MAX_UPLOAD_BYTES = 15 * 1024**2
MAX_RESULT_BYTES = 8 * 1024**2
MAX_RESERVED_BYTES = 128 * 1024**2
RETENTION_SECONDS = 3600
RESULT_RETENTION_SECONDS = 24 * 3600
MAX_CACHE_BYTES = 32 * 1024**2
MAX_PENDING = 4
MAX_JOBS = 16
MAX_OWNER_JOBS = 4
# Bump whenever extraction behavior changes; old text must not seed new results.
EXTRACTION_VERSION = 'tesseract5-eng-gray150-psm3-v1'
METADATA = 'id, owner, sha256, filename, state, completed_pages, total_pages, created, expires, attempts, error, selection, source_sha256, reused_pages'


class JobStore:
    def __init__(self, directory):
        import fcntl

        root = Path(directory)
        if not root.is_absolute() or root.is_symlink():
            raise RuntimeError('PDF_JOB_DIR must be an absolute private persistent directory')
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = root.stat()
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise RuntimeError('PDF_JOB_DIR must be owned by the API user with mode 0700')
        self.path = root / 'jobs.sqlite3'
        self.lock_fd = os.open(root / 'worker.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            try:
                db_info = os.fstat(fd)
                if not stat.S_ISREG(db_info.st_mode) or db_info.st_uid != os.getuid() or stat.S_IMODE(db_info.st_mode) & 0o077:
                    raise RuntimeError('PDF job database must be a private regular file')
            finally:
                os.close(fd)
            with self.connect() as db:
                version = db.execute('PRAGMA user_version').fetchone()[0]
                if version not in (0, 1, 2, 3, 4):
                    raise RuntimeError('Unsupported PDF job database version')
                db.execute('PRAGMA journal_mode=DELETE')
                db.executescript('''
                    CREATE TABLE IF NOT EXISTS jobs (
                        id TEXT PRIMARY KEY, owner TEXT NOT NULL, sha256 TEXT NOT NULL,
                        filename TEXT NOT NULL, state TEXT NOT NULL,
                        completed_pages INTEGER NOT NULL DEFAULT 0, total_pages INTEGER,
                        created REAL NOT NULL, expires REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                        input BLOB, result BLOB, reserved INTEGER NOT NULL, error TEXT
                    );
                    CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner, sha256, created);
                    CREATE TABLE IF NOT EXISTS checkpoints (
                        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                        page_number INTEGER NOT NULL, page BLOB NOT NULL,
                        PRIMARY KEY(job_id, page_number)
                    );
                ''')
            with self.transaction() as db:
                columns = {row[1] for row in db.execute('PRAGMA table_info(jobs)')}
                if 'selection' not in columns:
                    db.execute("ALTER TABLE jobs ADD COLUMN selection TEXT NOT NULL DEFAULT '[]'")
                if 'accessed' not in columns:
                    db.execute('ALTER TABLE jobs ADD COLUMN accessed REAL NOT NULL DEFAULT 0')
                    db.execute('UPDATE jobs SET accessed=created')
                db.execute('CREATE TABLE IF NOT EXISTS admissions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, created REAL NOT NULL)')
                db.execute('CREATE INDEX IF NOT EXISTS admissions_owner ON admissions(owner, created)')
                if version < 3:
                    db.execute('INSERT OR IGNORE INTO admissions SELECT id,owner,created FROM jobs WHERE created>?',
                               (time.time() - RETENTION_SECONDS,))
                for column, definition in (
                    ('source_sha256', "TEXT NOT NULL DEFAULT ''"),
                    ('extraction_version', "TEXT NOT NULL DEFAULT ''"),
                    ('reused_pages', 'INTEGER NOT NULL DEFAULT 0'),
                    ('cache_expires', 'REAL'),
                ):
                    if column not in columns:
                        db.execute(f'ALTER TABLE jobs ADD COLUMN {column} {definition}')
                db.execute('CREATE INDEX IF NOT EXISTS jobs_source ON jobs(owner,source_sha256,extraction_version)')
                db.execute('PRAGMA user_version=4')
            self.recover()
        except BaseException:
            os.close(self.lock_fd)
            raise

    def close(self):
        os.close(self.lock_fd)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=2, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA secure_delete=ON')
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('PRAGMA synchronous=FULL')
            db.execute('PRAGMA cache_size=-2048')
            db.execute('PRAGMA temp_store=MEMORY')
            db.execute('PRAGMA max_page_count=65536')  # 256 MiB at the default 4096-byte page size.
            yield db
        finally:
            db.close()

    @contextmanager
    def transaction(self):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                yield db
                db.execute('COMMIT')
            except BaseException:
                db.execute('ROLLBACK')
                raise

    def recover(self):
        with self.transaction() as db:
            self._cleanup(db, time.time())
            db.execute("""DELETE FROM checkpoints WHERE job_id IN
                (SELECT id FROM jobs WHERE state='processing' AND attempts>=2)""")
            db.execute("""UPDATE jobs SET state='failed', input=NULL, result=NULL, reserved=0,
                error='Processing was interrupted twice. Please upload the PDF again.'
                WHERE state='processing' AND attempts>=2""")
            db.execute("""UPDATE jobs SET state='queued',
                completed_pages=(SELECT count(*) FROM checkpoints WHERE job_id=jobs.id),
                total_pages=CASE WHEN EXISTS (SELECT 1 FROM checkpoints WHERE job_id=jobs.id)
                    THEN total_pages ELSE NULL END
                WHERE state='processing' AND attempts<2""")
            # Version-1 reservations covered input OR result. During resumed OCR
            # both input and bounded page checkpoints coexist on disk.
            db.execute("UPDATE jobs SET reserved=length(input)+? WHERE state IN ('queued','processing')",
                       (MAX_RESULT_BYTES,))

    def cleanup(self):
        with self.transaction() as db:
            self._cleanup(db, time.time())

    @staticmethod
    def _cleanup(db, now):
        db.execute('DELETE FROM jobs WHERE expires<=?', (now,))
        db.execute('DELETE FROM admissions WHERE created<=?', (now - RETENTION_SECONDS,))

    @staticmethod
    def _make_room(db, *, reserved=0, jobs=0, protect=''):
        # Evict only completed text, never active uploads/checkpoints. Admission
        # records survive eviction so cache churn cannot bypass hourly limits.
        while True:
            counts = db.execute('''SELECT count(*),coalesce(sum(reserved),0),
                coalesce(sum(CASE WHEN state='succeeded' THEN length(result) ELSE 0 END),0) FROM jobs''').fetchone()
            if counts[0] + jobs <= MAX_JOBS and counts[1] + reserved <= MAX_RESERVED_BYTES and counts[2] <= MAX_CACHE_BYTES:
                return
            victim = db.execute("SELECT id FROM jobs WHERE state='succeeded' AND id!=? ORDER BY accessed,created,id LIMIT 1",
                                (protect,)).fetchone()
            if victim is None:
                raise HTTPException(429, 'PDF processing storage is full. Please try again later.', headers={'Retry-After': '60'})
            db.execute('DELETE FROM jobs WHERE id=?', (victim['id'],))

    def submit(self, owner, filename, contents, page_numbers=None):
        if not contents or len(contents) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, 'PDF must be between 1 byte and 15 MB.')
        now = time.time()
        selected = [] if page_numbers is None else validate_selection(page_numbers)
        source_digest = hashlib.sha256(contents).hexdigest()
        digest = selection_identity(source_digest, selected)
        with self.transaction() as db:
            self._cleanup(db, now)
            previous = db.execute(f"""SELECT {METADATA} FROM jobs WHERE owner=? AND sha256=? AND extraction_version=?
                AND state IN ('queued','processing','succeeded') ORDER BY created DESC LIMIT 1""",
                (owner, digest, EXTRACTION_VERSION)).fetchone()
            if previous is not None:
                db.execute('UPDATE jobs SET accessed=? WHERE id=?', (now, previous['id']))
                return dict(previous)
            own_pending = db.execute("SELECT count(*) FROM jobs WHERE owner=? AND state IN ('queued','processing')", (owner,)).fetchone()[0]
            pending = db.execute("SELECT count(*) FROM jobs WHERE state IN ('queued','processing')").fetchone()[0]
            own_uploads = db.execute('SELECT count(*) FROM admissions WHERE owner=?', (owner,)).fetchone()[0]
            uploads = db.execute('SELECT count(*) FROM admissions').fetchone()[0]
            reservation = len(contents) + MAX_RESULT_BYTES
            if own_pending or own_uploads >= MAX_OWNER_JOBS or uploads >= MAX_JOBS or pending >= MAX_PENDING:
                raise HTTPException(429, 'PDF processing is busy or your hourly upload allowance is used. Try again later.',
                                    headers={'Retry-After': '60'})
            # Reuse only this owner's exact file and current extraction version.
            # A one-hour margin keeps seeds valid through the entire job lifetime.
            seeds, seed_expiry = {}, None
            for cached in db.execute("""SELECT result,expires FROM jobs WHERE owner=? AND source_sha256=?
                    AND extraction_version=? AND state='succeeded' AND expires>?
                    ORDER BY created DESC,id""", (owner, source_digest, EXTRACTION_VERSION, now + RETENTION_SECONDS)):
                for page in json.loads(cached['result']):
                    number = page['page_number']
                    if number not in seeds and (not selected or number in selected):
                        seeds[number] = page
                        seed_expiry = min(seed_expiry or cached['expires'], cached['expires'])
            saved = [seeds[number] for number in sorted(seeds)]
            try:
                validate_checkpoint(saved, total=len(selected) if selected else 100, page_numbers=selected)
            except ValueError as error:
                raise HTTPException(413, 'Extracted document text is too large.') from error
            self._make_room(db, reserved=reservation, jobs=1)
            job_id = str(uuid4())
            db.execute("""INSERT INTO jobs(id,owner,sha256,filename,state,created,expires,input,reserved,selection,accessed,source_sha256,extraction_version,reused_pages,completed_pages,total_pages,cache_expires)
                VALUES (?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?,?)""",
                (job_id, owner, digest, (filename or 'Study material.pdf')[:255], now,
                 now + RETENTION_SECONDS, contents, reservation, json.dumps(selected), now, source_digest, EXTRACTION_VERSION,
                 len(saved), len(saved), len(selected) if selected else None, seed_expiry))
            db.executemany('INSERT INTO checkpoints(job_id,page_number,page) VALUES (?,?,?)',
                           [(job_id, page['page_number'], json.dumps(page, separators=(',', ':')).encode()) for page in saved])
            db.execute('INSERT INTO admissions VALUES (?,?,?)', (job_id, owner, now))
            return dict(db.execute(f'SELECT {METADATA} FROM jobs WHERE id=?', (job_id,)).fetchone())

    def list_owned(self, owner):
        with self.connect() as db:
            return [dict(row) for row in db.execute(f'SELECT {METADATA} FROM jobs WHERE owner=? AND expires>? ORDER BY created DESC',
                                                    (owner, time.time()))]

    def get_owned(self, owner, job_id):
        with self.transaction() as db:
            row = db.execute(f'SELECT {METADATA}, result FROM jobs WHERE owner=? AND id=? AND expires>?',
                             (owner, job_id, time.time())).fetchone()
            if row is None:
                raise HTTPException(404, 'PDF job is unavailable or has expired.')
            if row['state'] == 'succeeded':
                db.execute('UPDATE jobs SET accessed=? WHERE id=?', (time.time(), job_id))
            result = dict(row)
            if result['result'] is not None:
                result['result'] = json.loads(result['result'])
            return result

    def get_document(self, owner, sha256):
        with self.transaction() as db:
            row = db.execute("""SELECT id,result FROM jobs WHERE owner=? AND sha256=? AND state='succeeded'
                AND expires>? ORDER BY created DESC LIMIT 1""", (owner, sha256, time.time())).fetchone()
            if row is None:
                return None
            db.execute('UPDATE jobs SET accessed=? WHERE id=?', (time.time(), row['id']))
            return {'pdf_sha256': sha256, 'pages': json.loads(row['result'])}

    def claim(self):
        with self.transaction() as db:
            now = time.time()
            self._cleanup(db, now)
            row = db.execute(f"SELECT {METADATA}, input FROM jobs WHERE state='queued' ORDER BY created LIMIT 1").fetchone()
            if row is None:
                return None
            db.execute("UPDATE jobs SET state='processing', attempts=attempts+1 WHERE id=?", (row['id'],))
            result = dict(row)
            result['checkpoint'] = [json.loads(page[0]) for page in db.execute(
                'SELECT page FROM checkpoints WHERE job_id=? ORDER BY page_number', (row['id'],))]
            selected = json.loads(row['selection'])
            validate_checkpoint(result['checkpoint'], total=len(selected) if selected else 100, page_numbers=selected)
            return result

    def checkpoint(self, job_id, pages, total):
        """Commit page text and visible progress together, before reporting it."""
        with self.transaction() as db:
            row = db.execute("""SELECT completed_pages,total_pages,selection FROM jobs
                WHERE id=? AND state='processing' AND expires>?""", (job_id, time.time())).fetchone()
            if row is None:
                return
            processed = {page[0] for page in db.execute('SELECT page_number FROM checkpoints WHERE job_id=?', (job_id,))}
            validate_next_pages(pages, processed, total=total, page_numbers=json.loads(row['selection']))
            if not pages or (row['total_pages'] is not None and row['total_pages'] != total):
                raise ValueError('Invalid checkpoint progress')
            encoded = [json.dumps(page, separators=(',', ':')).encode() for page in pages]
            size = db.execute('SELECT coalesce(sum(length(page)+1),0) FROM checkpoints WHERE job_id=?',
                              (job_id,)).fetchone()[0]
            if size + sum(len(page) + 1 for page in encoded) + 2 > MAX_PAGE_BYTES:
                raise HTTPException(413, 'Extracted document text is too large.')
            # Also enforce actual storage during a version-1 upgrade, where old
            # reservations did not allow input and checkpoints to coexist.
            payload_bytes = db.execute('''SELECT
                (SELECT coalesce(sum(coalesce(length(input),0)+coalesce(length(result),0)+2),0) FROM jobs)
                + (SELECT coalesce(sum(length(page)+1),0) FROM checkpoints)''').fetchone()[0]
            if payload_bytes + sum(len(page) + 1 for page in encoded) > MAX_RESERVED_BYTES:
                raise HTTPException(429, 'PDF processing storage is full. Please try again later.')
            db.executemany('INSERT INTO checkpoints(job_id,page_number,page) VALUES (?,?,?)',
                           [(job_id, page['page_number'], raw) for page, raw in zip(pages, encoded)])
            db.execute('UPDATE jobs SET completed_pages=?,total_pages=? WHERE id=?',
                       (row['completed_pages'] + len(pages), total, job_id))

    def finish(self, job_id, pages):
        raw = json.dumps(pages, separators=(',', ':')).encode()
        if len(raw) > MAX_RESULT_BYTES:
            raise HTTPException(413, 'Extracted document text is too large.')
        with self.transaction() as db:
            now = time.time()
            row = db.execute("SELECT selection,cache_expires FROM jobs WHERE id=? AND state='processing' AND expires>?", (job_id, now)).fetchone()
            if row is None:
                return
            selected = json.loads(row['selection'])
            validate_pages(pages, total=len(selected) if selected else 100, page_numbers=selected)
            if selected and len(pages) != len(selected):
                raise ValueError('Selected pages are incomplete')
            db.execute("""UPDATE jobs SET state='succeeded', completed_pages=?, total_pages=?,
                input=NULL, result=?, reserved=?, expires=?, accessed=? WHERE id=? AND state='processing' AND expires>?""",
                (len(pages), len(pages), raw, len(raw), min(now + RESULT_RETENTION_SECONDS, row['cache_expires'] or float('inf')), now, job_id, now))
            db.execute('DELETE FROM checkpoints WHERE job_id=?', (job_id,))
            self._make_room(db, protect=job_id)

    def fail(self, job_id, detail):
        with self.transaction() as db:
            db.execute("""UPDATE jobs SET state='failed', error=?, input=NULL, result=NULL, reserved=0
                WHERE id=? AND state='processing'""", (detail, job_id))
            db.execute('DELETE FROM checkpoints WHERE job_id=?', (job_id,))

    def cancel(self, owner, job_id):
        with self.transaction() as db:
            changed = db.execute("""UPDATE jobs SET state='cancelled', input=NULL, result=NULL, reserved=0, error=NULL,
                expires=min(expires,?)
                WHERE owner=? AND id=? AND expires>?""",
                (time.time() + RETENTION_SECONDS, owner, job_id, time.time())).rowcount
            if not changed:
                raise HTTPException(404, 'PDF job is unavailable or has expired.')
            db.execute('DELETE FROM checkpoints WHERE job_id=?', (job_id,))
