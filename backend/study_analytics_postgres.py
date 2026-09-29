"""PostgreSQL implementation of owner-scoped study analytics."""

from contextlib import asynccontextmanager
from datetime import (
    datetime,
    time,
    timedelta,
    timezone,
)
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from psycopg import Error as DatabaseError
from psycopg_pool import (
    PoolClosed,
    PoolTimeout,
    TooManyRequests,
)

from spaced_repetition import (
    DEFAULT_SCHEDULER,
    card_from_row,
)


MATURE_STABILITY_DAYS = 21.0
DIFFICULT_CARD_LIMIT = 5


class PostgresStudyAnalyticsRepository:
    def __init__(
        self,
        pool,
        *,
        issuer: str,
        subject: str,
    ):
        self.pool = pool
        self.issuer = issuer
        self.subject = subject

    @asynccontextmanager
    async def transaction(self):
        try:
            async with self.pool.connection() as conn:
                async with conn.transaction():
                    await conn.execute(
                        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"
                    )
                    await conn.execute(
                        """SELECT
                            set_config('quizforge.auth_issuer', %s, true),
                            set_config('quizforge.auth_subject', %s, true),
                            set_config('quizforge.user_id', '', true)""",
                        (
                            self.issuer,
                            self.subject,
                        ),
                    )
                    identities = await (
                        await conn.execute(
                            """SELECT user_id
                               FROM app.user_identities
                               WHERE issuer=%s AND subject=%s""",
                            (
                                self.issuer,
                                self.subject,
                            ),
                        )
                    ).fetchall()

                    if len(identities) != 1:
                        raise HTTPException(
                            403,
                            "Study analytics are not provisioned.",
                        )

                    user_id = identities[
                        0
                    ]["user_id"]
                    await conn.execute(
                        "SELECT set_config('quizforge.user_id', %s, true)",
                        (
                            str(user_id),
                        ),
                    )
                    yield conn, user_id
        except (
            DatabaseError,
            PoolClosed,
            PoolTimeout,
            TooManyRequests,
        ):
            raise HTTPException(
                503,
                "Study analytics are temporarily unavailable.",
            ) from None

    @staticmethod
    def _boundaries(
        now: datetime,
        timezone_name: str,
    ):
        zone = ZoneInfo(
            timezone_name
        )
        local_now = now.astimezone(
            zone
        )
        today_start_local = (
            datetime.combine(
                local_now.date(),
                time.min,
                tzinfo=zone,
            )
        )
        seven_day_start_local = (
            today_start_local
            - timedelta(days=6)
        )
        thirty_day_start_local = (
            today_start_local
            - timedelta(days=29)
        )

        return (
            today_start_local
            .astimezone(timezone.utc),
            seven_day_start_local
            .astimezone(timezone.utc),
            thirty_day_start_local
            .astimezone(timezone.utc),
        )

    @staticmethod
    def _estimated_retention(
        rows,
        now: datetime,
    ):
        if not rows:
            return None

        values = []
        for row in rows:
            try:
                card = card_from_row(
                    row
                )
                values.append(
                    DEFAULT_SCHEDULER
                    .get_card_retrievability(
                        card,
                        current_datetime=now,
                    )
                )
            except (
                ValueError,
                TypeError,
            ):
                continue

        if not values:
            return None

        return (
            sum(values)
            / len(values)
        )

    async def summary(
        self,
        *,
        timezone_name: str,
    ):
        now = datetime.now(
            timezone.utc
        )
        (
            today_start,
            seven_day_start,
            thirty_day_start,
        ) = self._boundaries(
            now,
            timezone_name,
        )

        async with self.transaction() as (
            conn,
            user_id,
        ):
            activity = await (
                await conn.execute(
                    """SELECT
                        count(*) FILTER (
                            WHERE reviewed_at >= %s
                        )::int AS reviews_today,
                        count(*) FILTER (
                            WHERE reviewed_at >= %s
                        )::int AS reviews_last_7_days,
                        coalesce(sum(review_duration_ms) FILTER (
                            WHERE reviewed_at >= %s
                        ),0)::bigint AS study_time_today_ms,
                        coalesce(sum(review_duration_ms) FILTER (
                            WHERE reviewed_at >= %s
                        ),0)::bigint AS study_time_last_7_days_ms,
                        count(DISTINCT (
                            reviewed_at AT TIME ZONE %s
                        )::date) FILTER (
                            WHERE reviewed_at >= %s
                        )::int AS active_days_last_7_days
                       FROM app.card_review_logs
                       WHERE user_id=%s""",
                    (
                        today_start,
                        seven_day_start,
                        today_start,
                        seven_day_start,
                        timezone_name,
                        seven_day_start,
                        user_id,
                    ),
                )
            ).fetchone()

            memory = await (
                await conn.execute(
                    """SELECT
                        count(*)::int AS total_cards,
                        count(*) FILTER (
                            WHERE suspended=false
                        )::int AS active_cards,
                        count(*) FILTER (
                            WHERE suspended=true
                        )::int AS suspended_cards,
                        count(*) FILTER (
                            WHERE suspended=false
                              AND due_at <= %s
                        )::int AS due_cards,
                        count(*) FILTER (
                            WHERE suspended=false
                              AND review_count=0
                        )::int AS new_cards,
                        count(*) FILTER (
                            WHERE suspended=false
                              AND review_count>0
                              AND fsrs_state IN (1,3)
                        )::int AS learning_cards,
                        count(*) FILTER (
                            WHERE suspended=false
                              AND review_count>0
                              AND fsrs_state=2
                        )::int AS review_cards,
                        count(*) FILTER (
                            WHERE suspended=false
                              AND review_count>0
                              AND stability >= %s
                        )::int AS mature_cards,
                        count(*) FILTER (
                            WHERE suspended=false
                              AND review_count>0
                              AND stability IS NOT NULL
                              AND last_reviewed_at IS NOT NULL
                        )::int AS retention_card_count
                       FROM app.cards
                       WHERE user_id=%s""",
                    (
                        now,
                        MATURE_STABILITY_DAYS,
                        user_id,
                    ),
                )
            ).fetchone()

            rating = await (
                await conn.execute(
                    """SELECT
                        count(*) FILTER (WHERE rating=1)::int AS again,
                        count(*) FILTER (WHERE rating=2)::int AS hard,
                        count(*) FILTER (WHERE rating=3)::int AS good,
                        count(*) FILTER (WHERE rating=4)::int AS easy,
                        count(*)::int AS total
                       FROM app.card_review_logs
                       WHERE user_id=%s
                         AND reviewed_at >= %s""",
                    (
                        user_id,
                        thirty_day_start,
                    ),
                )
            ).fetchone()

            retention_rows = await (
                await conn.execute(
                    """SELECT
                        id,
                        fsrs_state,
                        fsrs_step,
                        stability,
                        difficulty,
                        due_at,
                        last_reviewed_at
                       FROM app.cards
                       WHERE user_id=%s
                         AND suspended=false
                         AND review_count>0
                         AND stability IS NOT NULL
                         AND last_reviewed_at IS NOT NULL""",
                    (
                        user_id,
                    ),
                )
            ).fetchall()

            difficult = await (
                await conn.execute(
                    """SELECT
                        c.id AS card_id,
                        c.deck_id,
                        d.name AS deck_name,
                        c.question,
                        c.lapse_count,
                        c.review_count,
                        c.difficulty,
                        c.tags
                       FROM app.cards c
                       JOIN app.decks d
                         ON d.id=c.deck_id
                        AND d.user_id=c.user_id
                       WHERE c.user_id=%s
                         AND c.suspended=false
                         AND c.review_count>0
                       ORDER BY
                         c.lapse_count DESC,
                         c.difficulty DESC NULLS LAST,
                         c.review_count DESC,
                         c.id
                       LIMIT %s""",
                    (
                        user_id,
                        DIFFICULT_CARD_LIMIT,
                    ),
                )
            ).fetchall()

            decks = await (
                await conn.execute(
                    """SELECT count(*)::int AS total
                       FROM app.decks
                       WHERE user_id=%s""",
                    (
                        user_id,
                    ),
                )
            ).fetchone()

        retention = (
            self._estimated_retention(
                retention_rows,
                now,
            )
        )

        return {
            "timezone": timezone_name,
            "generated_at": now,
            "total_decks": decks["total"],
            "activity": {
                **activity,
                "study_time_today_ms":
                    int(
                        activity[
                            "study_time_today_ms"
                        ]
                    ),
                "study_time_last_7_days_ms":
                    int(
                        activity[
                            "study_time_last_7_days_ms"
                        ]
                    ),
            },
            "memory": {
                **memory,
                "estimated_retention":
                    retention,
            },
            "ratings_last_30_days":
                rating,
            "difficult_cards": [
                {
                    "card_id":
                        str(
                            row[
                                "card_id"
                            ]
                        ),
                    "deck_id":
                        str(
                            row[
                                "deck_id"
                            ]
                        ),
                    "deck_name":
                        row[
                            "deck_name"
                        ],
                    "question":
                        row[
                            "question"
                        ],
                    "lapse_count":
                        row[
                            "lapse_count"
                        ],
                    "review_count":
                        row[
                            "review_count"
                        ],
                    "difficulty":
                        row[
                            "difficulty"
                        ],
                    "tags":
                        row[
                            "tags"
                        ]
                        or [],
                }
                for row in difficult
            ],
        }
