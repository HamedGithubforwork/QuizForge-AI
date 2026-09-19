"""Parameterized history queries under transaction-local verified identities."""
from contextlib import asynccontextmanager

from fastapi import HTTPException
from psycopg import Error as DatabaseError
from psycopg.types.json import Jsonb
from psycopg_pool import PoolClosed, PoolTimeout, TooManyRequests
from pydantic import ValidationError

from processed_documents import normalize_document_sha256
from quiz_history import HistoryCursor, HistoryPage, HistoryRow


class PostgresHistoryRepository:
    def __init__(self, pool, *, issuer: str, subject: str):
        self.pool, self.issuer, self.subject = pool, issuer, subject

    @asynccontextmanager
    async def transaction(self):
        try:
            async with self.pool.connection() as conn:
                async with conn.transaction():
                    await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                    await conn.execute("""SELECT set_config('quizforge.auth_issuer', %s, true),
                        set_config('quizforge.auth_subject', %s, true),
                        set_config('quizforge.user_id', '', true)""", (self.issuer, self.subject))
                    identities = await (await conn.execute("""SELECT user_id FROM app.user_identities
                        WHERE issuer=%s AND subject=%s""", (self.issuer, self.subject))).fetchall()
                    if len(identities) != 1:
                        # Provision identities through reviewed migration/account workflows only.
                        raise HTTPException(403, "Quiz history access is not provisioned.")
                    user_id = identities[0]["user_id"]
                    await conn.execute("SELECT set_config('quizforge.user_id', %s, true)", (str(user_id),))
                    yield conn, user_id
        except (DatabaseError, PoolClosed, PoolTimeout, TooManyRequests):
            raise HTTPException(503, "Quiz history is temporarily unavailable.") from None

    @staticmethod
    def rows(raw, user_id):
        try:
            rows = [HistoryRow.model_validate(row) for row in raw]
            if any(row.user_id != user_id for row in rows):
                raise ValueError("Unexpected owner")
            return rows
        except (ValueError, ValidationError):
            raise HTTPException(502, "Quiz history returned an invalid response.") from None

    async def page(self, *, limit, cursor_created_at=None, cursor_id=None):
        async with self.transaction() as (conn, user_id):
            total = None
            if cursor_id is None:
                total = (await (await conn.execute(
                    "SELECT count(*) AS total FROM app.quiz_history WHERE user_id=%s", (user_id,))).fetchone())["total"]
                raw = await (await conn.execute("""SELECT * FROM app.quiz_history WHERE user_id=%s
                    ORDER BY created_at DESC,id DESC LIMIT %s""", (user_id, limit + 1))).fetchall()
            else:
                raw = await (await conn.execute("""SELECT * FROM app.quiz_history WHERE user_id=%s
                    AND (created_at,id)<(%s,%s) ORDER BY created_at DESC,id DESC LIMIT %s""",
                    (user_id, cursor_created_at, cursor_id, limit + 1))).fetchall()
            rows = self.rows(raw, user_id)
            items, more = rows[:limit], len(rows) > limit
            return HistoryPage(items=items, totalCount=total, hasMore=more,
                               nextCursor=HistoryCursor(createdAt=items[-1].created_at, id=items[-1].id)
                               if more else None)

    async def for_document(self, *, source_filename, document_sha256, limit):
        async with self.transaction() as (conn, user_id):
            if document_sha256 is None:
                raw = await (await conn.execute("""SELECT * FROM app.quiz_history
                    WHERE user_id=%s AND source_filename=%s ORDER BY created_at DESC,id DESC LIMIT %s""",
                    (user_id, source_filename, limit))).fetchall()
                return self.rows(raw, user_id)
            hashed = await (await conn.execute("""SELECT * FROM app.quiz_history
                WHERE user_id=%s AND document_sha256=%s ORDER BY created_at DESC,id DESC LIMIT %s""",
                (user_id, document_sha256, limit))).fetchall()
            legacy = await (await conn.execute("""SELECT * FROM app.quiz_history
                WHERE user_id=%s AND document_sha256 IS NULL AND source_filename=%s
                ORDER BY created_at DESC,id DESC LIMIT %s""", (user_id, source_filename, limit))).fetchall()
            rows = self.rows(hashed, user_id)
            for row in self.rows(legacy, user_id):
                nested = row.quiz_data if isinstance(row.quiz_data, dict) else {}
                legacy_hash = normalize_document_sha256(nested.get("document_sha256"))
                if legacy_hash is None or legacy_hash == document_sha256:
                    rows.append(row)
            unique = {row.id: row for row in rows}
            return sorted(unique.values(), key=lambda row: (row.created_at, row.id), reverse=True)[:limit]

    async def create(self, entry):
        async with self.transaction() as (conn, user_id):
            await conn.execute("""INSERT INTO app.quiz_history
                (user_id,quiz_title,source_filename,document_sha256,difficulty,question_type,
                 question_count,score,percentage,quiz_data,selected_answers)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (user_id, entry.quiz_title, entry.source_filename, entry.document_sha256,
                 entry.difficulty, entry.question_type, entry.question_count, entry.score,
                 entry.percentage, Jsonb(entry.quiz_data), Jsonb(entry.selected_answers)))

    async def delete(self, entry_id):
        async with self.transaction() as (conn, user_id):
            await conn.execute("DELETE FROM app.quiz_history WHERE id=%s AND user_id=%s", (entry_id, user_id))
