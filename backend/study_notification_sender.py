"""Send scheduled spaced-repetition reminders through Web Push.

Runs as a short-lived job under the dedicated quizforge_notifier database role.
It never reads quiz questions, answers, history, email addresses, or auth data.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timezone
import json
import os
from pathlib import Path
import re
from typing import Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import psycopg
from psycopg.rows import dict_row
from pywebpush import WebPushException, webpush


MAX_SUBSCRIPTIONS = 10_000
VAPID_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{80,300}$")
VAPID_SUBJECT_RE = re.compile(
    r"^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$"
)


@dataclass(frozen=True)
class ReminderCandidate:
    user_id: str
    reminder_time: time
    timezone_name: str
    minimum_due_cards: int
    endpoint_hash: str
    endpoint: str
    p256dh: str
    auth: str
    due_count: int


@dataclass(frozen=True)
class DeliveryWindow:
    local_date: date
    eligible: bool


def connection_settings(
    env: dict[str, str] | None = None,
):
    values = os.environ if env is None else env
    required = {
        "host": values.get("NOTIFIER_DB_HOST", ""),
        "dbname": values.get("NOTIFIER_DB_NAME", ""),
        "user": values.get("NOTIFIER_DB_USER", ""),
        "password": values.get("NOTIFIER_DB_PASSWORD", ""),
        "sslrootcert": values.get(
            "NOTIFIER_DB_SSLROOTCERT",
            "",
        ),
    }

    if (
        required["user"] != "quizforge_notifier"
        or required["dbname"] != "quizforge"
        or not required["host"]
        or not required["password"]
    ):
        raise ValueError(
            "Notifier database configuration is incomplete."
        )

    ca = Path(required["sslrootcert"])
    if not ca.is_file():
        raise ValueError(
            "Notifier database CA certificate is unavailable."
        )

    return {
        **required,
        "port": 5432,
        "sslmode": "verify-full",
        "connect_timeout": 10,
        "autocommit": True,
        "row_factory": dict_row,
        "options": (
            "-c statement_timeout=10000 "
            "-c lock_timeout=3000 "
            "-c idle_in_transaction_session_timeout=30000"
        ),
    }


def push_configuration(
    env: dict[str, str] | None = None,
):
    values = os.environ if env is None else env
    private_key = values.get(
        "WEB_PUSH_VAPID_PRIVATE_KEY",
        "",
    ).strip()
    subject = values.get(
        "WEB_PUSH_VAPID_SUBJECT",
        "",
    ).strip()

    if not VAPID_KEY_RE.fullmatch(
        private_key
    ):
        raise ValueError(
            "Web Push private key is missing or malformed."
        )
    if not VAPID_SUBJECT_RE.fullmatch(
        subject
    ):
        raise ValueError(
            "Web Push VAPID subject is missing or malformed."
        )

    return private_key, subject


def delivery_window(
    reminder_time: time,
    timezone_name: str,
    now: datetime,
) -> DeliveryWindow:
    if (
        now.tzinfo is None
        or now.utcoffset()
        is None
    ):
        raise ValueError(
            "Current time must be timezone-aware."
        )

    try:
        zone = ZoneInfo(
            timezone_name
        )
    except ZoneInfoNotFoundError:
        return DeliveryWindow(
            local_date=now.date(),
            eligible=False,
        )

    local = now.astimezone(zone)
    local_clock = (
        local.hour,
        local.minute,
    )
    scheduled_clock = (
        reminder_time.hour,
        reminder_time.minute,
    )

    return DeliveryWindow(
        local_date=local.date(),
        eligible=(
            local_clock
            >= scheduled_clock
        ),
    )


def load_candidates(
    connection,
    now: datetime,
) -> list[ReminderCandidate]:
    rows = connection.execute(
        """SELECT
            p.user_id,
            p.reminder_time,
            p.timezone,
            p.minimum_due_cards,
            s.endpoint_hash,
            s.endpoint,
            s.p256dh,
            s.auth,
            count(c.user_id)::int AS due_count
           FROM app.study_notification_preferences p
           JOIN app.study_push_subscriptions s
             ON s.user_id=p.user_id
           LEFT JOIN app.cards c
             ON c.user_id=p.user_id
            AND c.due_at <= %s
           WHERE p.enabled
           GROUP BY
             p.user_id,
             p.reminder_time,
             p.timezone,
             p.minimum_due_cards,
             s.endpoint_hash,
             s.endpoint,
             s.p256dh,
             s.auth
           HAVING count(c.user_id) >= p.minimum_due_cards
           ORDER BY p.user_id,s.endpoint_hash
           LIMIT %s""",
        (
            now,
            MAX_SUBSCRIPTIONS + 1,
        ),
    ).fetchall()

    if (
        len(rows)
        > MAX_SUBSCRIPTIONS
    ):
        raise RuntimeError(
            "Notifier subscription bound exceeded."
        )

    return [
        ReminderCandidate(
            user_id=str(
                row["user_id"]
            ),
            reminder_time=
                row["reminder_time"],
            timezone_name=
                row["timezone"],
            minimum_due_cards=
                row[
                    "minimum_due_cards"
                ],
            endpoint_hash=
                row["endpoint_hash"],
            endpoint=
                row["endpoint"],
            p256dh=
                row["p256dh"],
            auth=row["auth"],
            due_count=
                row["due_count"],
        )
        for row in rows
    ]


def payload(
    due_count: int,
) -> str:
    noun = (
        "card"
        if due_count == 1
        else "cards"
    )
    return json.dumps(
        {
            "title":
                "Quiz From Notes",
            "body":
                f"You have {due_count} study {noun} ready to review.",
            "url": "/decks",
        },
        separators=(",", ":"),
    )


def push_once(
    connection,
    candidate: ReminderCandidate,
    local_date: date,
    *,
    private_key: str,
    subject: str,
    send: Callable = webpush,
) -> str:
    lock_key = (
        candidate.endpoint_hash
        + ":"
        + local_date.isoformat()
    )

    with connection.transaction():
        locked = connection.execute(
            """SELECT pg_try_advisory_xact_lock(
                   hashtextextended(%s, 0)
               )""",
            (lock_key,),
        ).fetchone()[0]

        if not locked:
            return "locked"

        sent = connection.execute(
            """SELECT 1
               FROM app.study_notification_deliveries
               WHERE user_id=%s
                 AND endpoint_hash=%s
                 AND local_date=%s""",
            (
                candidate.user_id,
                candidate.endpoint_hash,
                local_date,
            ),
        ).fetchone()

        if sent is not None:
            return "duplicate"

        try:
            send(
                subscription_info={
                    "endpoint":
                        candidate.endpoint,
                    "keys": {
                        "p256dh":
                            candidate.p256dh,
                        "auth":
                            candidate.auth,
                    },
                },
                data=payload(
                    candidate.due_count
                ),
                vapid_private_key=
                    private_key,
                vapid_claims={
                    "sub": subject,
                },
                ttl=3600,
            )
        except WebPushException as error:
            if (
                error.status_code
                in (404, 410)
            ):
                connection.execute(
                    """DELETE
                       FROM app.study_push_subscriptions
                       WHERE endpoint_hash=%s
                         AND user_id=%s""",
                    (
                        candidate.endpoint_hash,
                        candidate.user_id,
                    ),
                )
                return "expired"

            if (
                error.status_code
                in (429, 503)
            ):
                return "retry"

            return "failed"
        except Exception:
            return "failed"

        connection.execute(
            """INSERT INTO app.study_notification_deliveries(
                user_id,
                endpoint_hash,
                local_date,
                due_count
            ) VALUES (%s,%s,%s,%s)
            ON CONFLICT DO NOTHING""",
            (
                candidate.user_id,
                candidate.endpoint_hash,
                local_date,
                candidate.due_count,
            ),
        )

        return "sent"


def run(
    *,
    now: datetime | None = None,
    connect=psycopg.connect,
    send: Callable = webpush,
    env: dict[str, str] | None = None,
):
    current = (
        datetime.now(
            timezone.utc
        )
        if now is None
        else now
    )
    if (
        current.tzinfo is None
        or current.utcoffset()
        is None
    ):
        raise ValueError(
            "Notifier current time must be timezone-aware."
        )

    private_key, subject = (
        push_configuration(env)
    )
    settings = (
        connection_settings(env)
    )

    counts = {
        name: 0
        for name in (
            "eligible",
            "sent",
            "duplicate",
            "expired",
            "retry",
            "failed",
            "locked",
            "before_time",
            "invalid_timezone",
        )
    }

    with connect(
        **settings
    ) as connection:
        candidates = load_candidates(
            connection,
            current,
        )

        for candidate in candidates:
            window = (
                delivery_window(
                    candidate.reminder_time,
                    candidate.timezone_name,
                    current,
                )
            )

            if not window.eligible:
                try:
                    ZoneInfo(
                        candidate.timezone_name
                    )
                except ZoneInfoNotFoundError:
                    counts[
                        "invalid_timezone"
                    ] += 1
                else:
                    counts[
                        "before_time"
                    ] += 1
                continue

            counts["eligible"] += 1
            outcome = push_once(
                connection,
                candidate,
                window.local_date,
                private_key=
                    private_key,
                subject=subject,
                send=send,
            )
            counts[outcome] += 1

    return {
        "candidate_count":
            sum(
                counts[name]
                for name in (
                    "eligible",
                    "before_time",
                    "invalid_timezone",
                )
            ),
        **counts,
    }


def main() -> int:
    try:
        result = run()
        print(
            json.dumps(
                result,
                sort_keys=True,
            )
        )
        return (
            1
            if result["failed"] > 0
            else 0
        )
    except Exception as error:
        print(
            "QF_STUDY_NOTIFICATION_FAILED="
            + type(error).__name__,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
