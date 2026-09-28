"""PostgreSQL study-notification preferences under verified ownership."""

from contextlib import asynccontextmanager
from datetime import time
import hashlib

from fastapi import HTTPException
from psycopg import Error as DatabaseError
from psycopg.errors import UniqueViolation
from psycopg_pool import PoolClosed, PoolTimeout, TooManyRequests


class PostgresNotificationPreferencesRepository:
    def __init__(self, pool, *, issuer: str, subject: str):
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
                            "Study notification settings are not provisioned.",
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
                "Study notification settings are temporarily unavailable.",
            ) from None

    @staticmethod
    def response(row):
        if row is None:
            return {
                "enabled": False,
                "reminder_time": time(19, 0),
                "timezone": "America/Toronto",
                "minimum_due_cards": 1,
            }
        return {
            "enabled": row["enabled"],
            "reminder_time": row["reminder_time"],
            "timezone": row["timezone"],
            "minimum_due_cards": row["minimum_due_cards"],
        }

    async def get(self):
        async with self.transaction() as (conn, user_id):
            row = await (
                await conn.execute(
                    """SELECT enabled,reminder_time,timezone,minimum_due_cards
                       FROM app.study_notification_preferences
                       WHERE user_id=%s""",
                    (user_id,),
                )
            ).fetchone()
            return self.response(row)

    async def save(self, payload):
        async with self.transaction() as (conn, user_id):
            row = await (
                await conn.execute(
                    """INSERT INTO app.study_notification_preferences(
                        user_id,enabled,reminder_time,timezone,minimum_due_cards
                    ) VALUES (%s,%s,%s,%s,%s)
                    ON CONFLICT (user_id) DO UPDATE SET
                        enabled=EXCLUDED.enabled,
                        reminder_time=EXCLUDED.reminder_time,
                        timezone=EXCLUDED.timezone,
                        minimum_due_cards=EXCLUDED.minimum_due_cards,
                        updated_at=now()
                    RETURNING enabled,reminder_time,timezone,minimum_due_cards""",
                    (
                        user_id,
                        payload.enabled,
                        payload.reminder_time,
                        payload.timezone,
                        payload.minimum_due_cards,
                    ),
                )
            ).fetchone()
            if row is None:
                raise HTTPException(
                    503,
                    "Study notification settings are temporarily unavailable.",
                )
            return self.response(row)

    @staticmethod
    def endpoint_hash(endpoint: str) -> str:
        return hashlib.sha256(
            endpoint.encode("utf-8")
        ).hexdigest()

    async def save_subscription(
        self,
        *,
        endpoint: str,
        p256dh: str,
        auth: str,
        user_agent: str | None,
    ):
        endpoint_hash = self.endpoint_hash(
            endpoint
        )

        async with self.transaction() as (
            conn,
            user_id,
        ):
            existing = await (
                await conn.execute(
                    """SELECT endpoint_hash
                       FROM app.study_push_subscriptions
                       WHERE endpoint_hash=%s AND user_id=%s""",
                    (
                        endpoint_hash,
                        user_id,
                    ),
                )
            ).fetchone()

            if existing is not None:
                row = await (
                    await conn.execute(
                        """UPDATE app.study_push_subscriptions
                           SET endpoint=%s,p256dh=%s,auth=%s,user_agent=%s,
                               updated_at=now()
                           WHERE endpoint_hash=%s AND user_id=%s
                           RETURNING endpoint_hash""",
                        (
                            endpoint,
                            p256dh,
                            auth,
                            user_agent,
                            endpoint_hash,
                            user_id,
                        ),
                    )
                ).fetchone()
            else:
                try:
                    row = await (
                        await conn.execute(
                            """INSERT INTO app.study_push_subscriptions(
                                endpoint_hash,user_id,endpoint,p256dh,auth,user_agent
                            ) VALUES (%s,%s,%s,%s,%s,%s)
                            RETURNING endpoint_hash""",
                            (
                                endpoint_hash,
                                user_id,
                                endpoint,
                                p256dh,
                                auth,
                                user_agent,
                            ),
                        )
                    ).fetchone()
                except UniqueViolation:
                    raise HTTPException(
                        409,
                        "This browser push subscription is linked to another account.",
                    ) from None

            if row is None:
                raise HTTPException(
                    503,
                    "Browser push subscription could not be saved.",
                )

            return {
                "endpoint_hash":
                    row["endpoint_hash"],
            }

    async def delete_subscription(
        self,
        endpoint_hash: str,
    ):
        async with self.transaction() as (
            conn,
            user_id,
        ):
            await conn.execute(
                """DELETE FROM app.study_push_subscriptions
                   WHERE endpoint_hash=%s AND user_id=%s""",
                (
                    endpoint_hash,
                    user_id,
                ),
            )

