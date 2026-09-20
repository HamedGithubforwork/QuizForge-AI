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

MAX_UPLOAD_BYTES = 15 * 1024**2
MAX_RESULT_BYTES = 8 * 1024**2
MAX_RESERVED_BYTES = 128 * 1024**2
RETENTION_SECONDS = 3600
MAX_PENDING = 4
MAX_JOBS = 16
MAX_OWNER_JOBS = 4
METADATA = 'id, owner, sha256, filename, state, completed_pages, total_pages, created, expires, attempts, error'


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
                if version not in (0, 1):
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
                    PRAGMA user_version=1;
                ''')
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
            db.execute('DELETE FROM jobs WHERE expires<=?', (time.time(),))
            db.execute("""UPDATE jobs SET state='failed', input=NULL, result=NULL, reserved=0,
                error='Processing was interrupted twice. Please upload the PDF again.'
                WHERE state='processing' AND attempts>=2""")
            db.execute("""UPDATE jobs SET state='queued', completed_pages=0, total_pages=NULL
                WHERE state='processing' AND attempts<2""")

    def cleanup(self):
        with self.connect() as db:
            db.execute('DELETE FROM jobs WHERE expires<=?', (time.time(),))

    def submit(self, owner, filename, contents):
        if not contents or len(contents) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, 'PDF must be between 1 byte and 15 MB.')
        now = time.time()
        digest = hashlib.sha256(contents).hexdigest()
        with self.transaction() as db:
            db.execute('DELETE FROM jobs WHERE expires<=?', (now,))
            previous = db.execute(f"""SELECT {METADATA} FROM jobs WHERE owner=? AND sha256=?
                AND state IN ('queued','processing','succeeded') ORDER BY created DESC LIMIT 1""",
                (owner, digest)).fetchone()
            if previous is not None:
                return dict(previous)
            own = db.execute("""SELECT count(*), coalesce(sum(state IN ('queued','processing')),0)
                FROM jobs WHERE owner=?""", (owner,)).fetchone()
            counts = db.execute("""SELECT count(*), coalesce(sum(state IN ('queued','processing')),0),
                coalesce(sum(reserved),0) FROM jobs""").fetchone()
            reservation = max(len(contents), MAX_RESULT_BYTES)
            if own[1] or own[0] >= MAX_OWNER_JOBS or counts[0] >= MAX_JOBS or counts[1] >= MAX_PENDING or counts[2] + reservation > MAX_RESERVED_BYTES:
                raise HTTPException(429, 'PDF processing is busy or your hourly upload allowance is used. Try again later.',
                                    headers={'Retry-After': '60'})
            job_id = str(uuid4())
            db.execute("""INSERT INTO jobs(id,owner,sha256,filename,state,created,expires,input,reserved)
                VALUES (?,?,?,?,'queued',?,?,?,?)""",
                (job_id, owner, digest, (filename or 'Study material.pdf')[:255], now,
                 now + RETENTION_SECONDS, contents, reservation))
            return dict(db.execute(f'SELECT {METADATA} FROM jobs WHERE id=?', (job_id,)).fetchone())

    def list_owned(self, owner):
        with self.connect() as db:
            return [dict(row) for row in db.execute(f'SELECT {METADATA} FROM jobs WHERE owner=? AND expires>? ORDER BY created DESC',
                                                    (owner, time.time()))]

    def get_owned(self, owner, job_id):
        with self.connect() as db:
            row = db.execute(f'SELECT {METADATA}, result FROM jobs WHERE owner=? AND id=? AND expires>?',
                             (owner, job_id, time.time())).fetchone()
            if row is None:
                raise HTTPException(404, 'PDF job is unavailable or has expired.')
            result = dict(row)
            if result['result'] is not None:
                result['result'] = json.loads(result['result'])
            return result

    def get_document(self, owner, sha256):
        with self.connect() as db:
            row = db.execute("""SELECT result FROM jobs WHERE owner=? AND sha256=? AND state='succeeded'
                AND expires>? ORDER BY created DESC LIMIT 1""", (owner, sha256, time.time())).fetchone()
            return {'pdf_sha256': sha256, 'pages': json.loads(row[0])} if row else None

    def claim(self):
        with self.transaction() as db:
            now = time.time()
            db.execute('DELETE FROM jobs WHERE expires<=?', (now,))
            row = db.execute(f"SELECT {METADATA}, input FROM jobs WHERE state='queued' ORDER BY created LIMIT 1").fetchone()
            if row is None:
                return None
            db.execute("UPDATE jobs SET state='processing', attempts=attempts+1 WHERE id=?", (row['id'],))
            return dict(row)

    def progress(self, job_id, completed, total):
        with self.connect() as db:
            db.execute("""UPDATE jobs SET completed_pages=?, total_pages=?
                WHERE id=? AND state='processing' AND completed_pages<=?""", (completed, total, job_id, completed))

    def finish(self, job_id, pages):
        raw = json.dumps(pages, separators=(',', ':')).encode()
        if len(raw) > MAX_RESULT_BYTES:
            raise HTTPException(413, 'Extracted document text is too large.')
        with self.connect() as db:
            db.execute("""UPDATE jobs SET state='succeeded', completed_pages=?, total_pages=?,
                input=NULL, result=?, reserved=? WHERE id=? AND state='processing' AND expires>?""",
                (len(pages), len(pages), raw, len(raw), job_id, time.time()))

    def fail(self, job_id, detail):
        with self.connect() as db:
            db.execute("""UPDATE jobs SET state='failed', error=?, input=NULL, result=NULL, reserved=0
                WHERE id=? AND state='processing'""", (detail, job_id))

    def cancel(self, owner, job_id):
        with self.connect() as db:
            changed = db.execute("""UPDATE jobs SET state='cancelled', input=NULL, result=NULL, reserved=0, error=NULL
                WHERE owner=? AND id=? AND expires>?""", (owner, job_id, time.time())).rowcount
            if not changed:
                raise HTTPException(404, 'PDF job is unavailable or has expired.')
