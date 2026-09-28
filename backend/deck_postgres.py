"""PostgreSQL deck queries under transaction-local verified identities."""

from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import HTTPException
from psycopg import Error as DatabaseError, sql
from psycopg.types.json import Jsonb
from psycopg_pool import PoolClosed, PoolTimeout, TooManyRequests

from spaced_repetition import schedule_review


class PostgresDeckRepository:
    def __init__(self, pool, *, issuer: str, subject: str):
        self.pool = pool
        self.issuer = issuer
        self.subject = subject

    @asynccontextmanager
    async def transaction(self, *, isolation="REPEATABLE READ"):
        if isolation not in ("REPEATABLE READ", "READ COMMITTED"):
            raise ValueError("Unsupported transaction isolation level.")
        try:
            async with self.pool.connection() as conn:
                async with conn.transaction():
                    await conn.execute(
                        "SET TRANSACTION ISOLATION LEVEL " + isolation
                    )
                    await conn.execute(
                        """SELECT
                            set_config('quizforge.auth_issuer', %s, true),
                            set_config('quizforge.auth_subject', %s, true),
                            set_config('quizforge.user_id', '', true)""",
                        (self.issuer, self.subject),
                    )
                    identities = await (
                        await conn.execute(
                            """SELECT user_id
                               FROM app.user_identities
                               WHERE issuer=%s AND subject=%s""",
                            (self.issuer, self.subject),
                        )
                    ).fetchall()
                    if len(identities) != 1:
                        raise HTTPException(
                            403,
                            "Study deck access is not provisioned.",
                        )
                    user_id = identities[0]["user_id"]
                    await conn.execute(
                        "SELECT set_config('quizforge.user_id', %s, true)",
                        (str(user_id),),
                    )
                    yield conn, user_id
        except (DatabaseError, PoolClosed, PoolTimeout, TooManyRequests):
            raise HTTPException(
                503,
                "Study decks are temporarily unavailable.",
            ) from None

    @staticmethod
    def _summary(row, user_id):
        if row is None:
            raise HTTPException(404, "Deck does not exist.")
        if row["user_id"] != user_id:
            raise HTTPException(
                502,
                "Study deck storage returned an invalid response.",
            )
        return {
            "id": row["id"],
            "name": row["name"],
            "description": row["description"],
            "card_count": row["card_count"],
            "due_count": row["due_count"],
            "next_due_at": row["next_due_at"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _cards(rows, user_id):
        result = []
        for row in rows:
            if row["user_id"] != user_id:
                raise HTTPException(
                    502,
                    "Study deck storage returned an invalid response.",
                )
            result.append(
                {
                    "id": row["id"],
                    "deck_id": row["deck_id"],
                    "question_type": row["question_type"],
                    "question": row["question"],
                    "answer": row["answer"],
                    "choices": row["choices"],
                    "explanation": row["explanation"],
                    "source_filename": row["source_filename"],
                    "document_sha256": row["document_sha256"],
                    "source_pages": row["source_pages"],
                    "fsrs_state": row["fsrs_state"],
                    "fsrs_step": row["fsrs_step"],
                    "stability": row["stability"],
                    "difficulty": row["difficulty"],
                    "due_at": row["due_at"],
                    "last_reviewed_at": row["last_reviewed_at"],
                    "review_count": row["review_count"],
                    "lapse_count": row["lapse_count"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }
            )
        return result

    async def _summary_row(self, conn, user_id, deck_id):
        return await (
            await conn.execute(
                """SELECT d.id,d.user_id,d.name,d.description,d.created_at,d.updated_at,
                          count(c.id)::int AS card_count,
                          count(c.id) FILTER (WHERE c.due_at <= now())::int AS due_count,
                          min(c.due_at) FILTER (WHERE c.due_at > now()) AS next_due_at
                   FROM app.decks d
                   LEFT JOIN app.cards c
                     ON c.deck_id=d.id AND c.user_id=d.user_id
                   WHERE d.id=%s AND d.user_id=%s
                   GROUP BY d.id,d.user_id,d.name,d.description,d.created_at,d.updated_at""",
                (deck_id, user_id),
            )
        ).fetchone()

    async def _detail(self, conn, user_id, deck_id):
        summary = self._summary(
            await self._summary_row(conn, user_id, deck_id),
            user_id,
        )
        rows = await (
            await conn.execute(
                """SELECT id,deck_id,user_id,question_type,question,answer,choices,
                          explanation,source_filename,document_sha256,source_pages,
                          fsrs_state,fsrs_step,stability,difficulty,due_at,last_reviewed_at,
                          review_count,lapse_count,created_at,updated_at
                   FROM app.cards
                   WHERE deck_id=%s AND user_id=%s
                   ORDER BY created_at,id""",
                (deck_id, user_id),
            )
        ).fetchall()
        return {**summary, "cards": self._cards(rows, user_id)}

    async def _insert_cards(self, conn, user_id, deck_id, cards):
        for card in cards:
            await conn.execute(
                """INSERT INTO app.cards(
                    deck_id,user_id,question_type,question,answer,choices,
                    explanation,source_filename,document_sha256,source_pages
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    deck_id,
                    user_id,
                    card.question_type,
                    card.question,
                    Jsonb(card.answer),
                    Jsonb(card.choices) if card.choices is not None else None,
                    card.explanation,
                    card.source_filename,
                    card.document_sha256,
                    card.source_pages,
                ),
            )

    async def list(self):
        async with self.transaction() as (conn, user_id):
            rows = await (
                await conn.execute(
                    """SELECT d.id,d.user_id,d.name,d.description,d.created_at,d.updated_at,
                              count(c.id)::int AS card_count,
                              count(c.id) FILTER (WHERE c.due_at <= now())::int AS due_count,
                              min(c.due_at) FILTER (WHERE c.due_at > now()) AS next_due_at
                       FROM app.decks d
                       LEFT JOIN app.cards c
                         ON c.deck_id=d.id AND c.user_id=d.user_id
                       WHERE d.user_id=%s
                       GROUP BY d.id,d.user_id,d.name,d.description,d.created_at,d.updated_at
                       ORDER BY
                         count(c.id) FILTER (WHERE c.due_at <= now()) DESC,
                         d.updated_at DESC,
                         d.id DESC""",
                    (user_id,),
                )
            ).fetchall()
            return [self._summary(row, user_id) for row in rows]

    async def get(self, deck_id):
        async with self.transaction() as (conn, user_id):
            return await self._detail(conn, user_id, deck_id)

    async def create(self, payload):
        async with self.transaction() as (conn, user_id):
            row = await (
                await conn.execute(
                    """INSERT INTO app.decks(user_id,name,description)
                       VALUES (%s,%s,%s)
                       RETURNING id""",
                    (user_id, payload.name, payload.description),
                )
            ).fetchone()
            deck_id = row["id"]
            await self._insert_cards(
                conn,
                user_id,
                deck_id,
                payload.cards,
            )
            return await self._detail(conn, user_id, deck_id)

    async def duplicate(
        self,
        deck_id,
        *,
        name=None,
    ):
        async with self.transaction() as (
            conn,
            user_id,
        ):
            source = await (
                await conn.execute(
                    """SELECT name,description
                       FROM app.decks
                       WHERE id=%s AND user_id=%s""",
                    (
                        deck_id,
                        user_id,
                    ),
                )
            ).fetchone()

            if source is None:
                raise HTTPException(
                    404,
                    "Deck does not exist.",
                )

            copy_name = name
            if copy_name is None:
                prefix = "Copy of "
                copy_name = (
                    prefix
                    + source["name"][
                        : 200
                        - len(prefix)
                    ]
                )

            created = await (
                await conn.execute(
                    """INSERT INTO app.decks(
                        user_id,name,description
                    ) VALUES (%s,%s,%s)
                    RETURNING id""",
                    (
                        user_id,
                        copy_name,
                        source[
                            "description"
                        ],
                    ),
                )
            ).fetchone()
            new_deck_id = (
                created["id"]
            )

            await conn.execute(
                """INSERT INTO app.cards(
                    deck_id,
                    user_id,
                    question_type,
                    question,
                    answer,
                    choices,
                    explanation,
                    source_filename,
                    document_sha256,
                    source_pages
                )
                SELECT
                    %s,
                    %s,
                    question_type,
                    question,
                    answer,
                    choices,
                    explanation,
                    source_filename,
                    document_sha256,
                    source_pages
                FROM app.cards
                WHERE deck_id=%s
                  AND user_id=%s
                ORDER BY created_at,id""",
                (
                    new_deck_id,
                    user_id,
                    deck_id,
                    user_id,
                ),
            )

            return await self._detail(
                conn,
                user_id,
                new_deck_id,
            )

    async def update(self, deck_id, payload):
        async with self.transaction() as (conn, user_id):
            assignments = []
            values = []

            if "name" in payload.model_fields_set:
                assignments.append(sql.SQL("name=%s"))
                values.append(payload.name)
            if "description" in payload.model_fields_set:
                assignments.append(sql.SQL("description=%s"))
                values.append(payload.description)

            assignments.append(sql.SQL("updated_at=now()"))
            values.extend((deck_id, user_id))
            query = sql.SQL(
                "UPDATE app.decks SET {} WHERE id=%s AND user_id=%s RETURNING id"
            ).format(sql.SQL(",").join(assignments))
            row = await (await conn.execute(query, values)).fetchone()
            if row is None:
                raise HTTPException(404, "Deck does not exist.")
            return await self._detail(conn, user_id, deck_id)

    async def delete(self, deck_id):
        async with self.transaction() as (conn, user_id):
            row = await (
                await conn.execute(
                    "DELETE FROM app.decks WHERE id=%s AND user_id=%s RETURNING id",
                    (deck_id, user_id),
                )
            ).fetchone()
            if row is None:
                raise HTTPException(404, "Deck does not exist.")

    async def add_cards(self, deck_id, cards):
        async with self.transaction() as (conn, user_id):
            if await self._summary_row(conn, user_id, deck_id) is None:
                raise HTTPException(404, "Deck does not exist.")
            await self._insert_cards(conn, user_id, deck_id, cards)
            await conn.execute(
                "UPDATE app.decks SET updated_at=now() WHERE id=%s AND user_id=%s",
                (deck_id, user_id),
            )
            return await self._detail(conn, user_id, deck_id)

    async def review_queue(self, deck_id, *, limit):
        async with self.transaction() as (conn, user_id):
            summary_row = await self._summary_row(
                conn,
                user_id,
                deck_id,
            )
            summary = self._summary(
                summary_row,
                user_id,
            )
            stats = await (
                await conn.execute(
                    """SELECT
                        count(*) FILTER (WHERE due_at <= now())::int AS due_count,
                        min(due_at) FILTER (WHERE due_at > now()) AS next_due_at
                       FROM app.cards
                       WHERE deck_id=%s AND user_id=%s""",
                    (deck_id, user_id),
                )
            ).fetchone()
            rows = await (
                await conn.execute(
                    """SELECT id,deck_id,user_id,question_type,question,answer,choices,
                              explanation,source_filename,document_sha256,source_pages,
                              fsrs_state,fsrs_step,stability,difficulty,due_at,last_reviewed_at,
                              review_count,lapse_count,created_at,updated_at
                       FROM app.cards
                       WHERE deck_id=%s AND user_id=%s AND due_at <= now()
                       ORDER BY due_at,created_at,id
                       LIMIT %s""",
                    (deck_id, user_id, limit),
                )
            ).fetchall()
            return {
                "deck_id": deck_id,
                "deck_name": summary["name"],
                "due_count": stats["due_count"],
                "next_due_at": stats["next_due_at"],
                "cards": self._cards(rows, user_id),
            }

    async def review_card(
        self,
        deck_id,
        *,
        card_id,
        rating,
        review_duration_ms,
    ):
        async with self.transaction(
            isolation="READ COMMITTED"
        ) as (conn, user_id):
            row = await (
                await conn.execute(
                    """SELECT id,deck_id,user_id,question_type,question,answer,choices,
                              explanation,source_filename,document_sha256,source_pages,
                              fsrs_state,fsrs_step,stability,difficulty,due_at,last_reviewed_at,
                              review_count,lapse_count,created_at,updated_at
                       FROM app.cards
                       WHERE id=%s AND deck_id=%s AND user_id=%s
                       FOR UPDATE""",
                    (card_id, deck_id, user_id),
                )
            ).fetchone()
            if row is None:
                raise HTTPException(
                    404,
                    "Card does not exist in this deck.",
                )

            reviewed_at = datetime.now(
                timezone.utc
            )
            if row["due_at"] > reviewed_at:
                raise HTTPException(
                    409,
                    "This card is not due yet.",
                )

            try:
                scheduled = schedule_review(
                    row,
                    rating,
                    review_datetime=reviewed_at,
                    review_duration_ms=review_duration_ms,
                )
            except ValueError:
                raise HTTPException(
                    422,
                    "Review rating or duration is invalid.",
                ) from None
            except RuntimeError:
                raise HTTPException(
                    503,
                    "Spaced repetition scheduling is temporarily unavailable.",
                ) from None

            updated = await (
                await conn.execute(
                    """UPDATE app.cards SET
                        fsrs_state=%s,
                        fsrs_step=%s,
                        stability=%s,
                        difficulty=%s,
                        due_at=%s,
                        last_reviewed_at=%s,
                        review_count=review_count+1,
                        lapse_count=lapse_count+%s,
                        updated_at=now()
                       WHERE id=%s AND deck_id=%s AND user_id=%s
                       RETURNING id,deck_id,user_id,question_type,question,answer,choices,
                                 explanation,source_filename,document_sha256,source_pages,
                                 fsrs_state,fsrs_step,stability,difficulty,due_at,last_reviewed_at,
                                 review_count,lapse_count,created_at,updated_at""",
                    (
                        scheduled.fsrs_state,
                        scheduled.fsrs_step,
                        scheduled.stability,
                        scheduled.difficulty,
                        scheduled.due_at,
                        scheduled.last_reviewed_at,
                        scheduled.lapse_increment,
                        card_id,
                        deck_id,
                        user_id,
                    ),
                )
            ).fetchone()
            if updated is None:
                raise HTTPException(
                    404,
                    "Card does not exist in this deck.",
                )

            await conn.execute(
                """INSERT INTO app.card_review_logs(
                    card_id,user_id,rating,reviewed_at,review_duration_ms
                ) VALUES (%s,%s,%s,%s,%s)""",
                (
                    card_id,
                    user_id,
                    scheduled.rating,
                    scheduled.reviewed_at,
                    scheduled.review_duration_ms,
                ),
            )

            stats = await (
                await conn.execute(
                    """SELECT
                        count(*) FILTER (WHERE due_at <= now())::int AS due_count,
                        min(due_at) FILTER (WHERE due_at > now()) AS next_due_at
                       FROM app.cards
                       WHERE deck_id=%s AND user_id=%s""",
                    (deck_id, user_id),
                )
            ).fetchone()

            return {
                "card": self._cards(
                    [updated],
                    user_id,
                )[0],
                "remaining_due_count": stats["due_count"],
                "next_due_at": stats["next_due_at"],
            }

