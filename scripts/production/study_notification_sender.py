"""Scheduled, least-privilege study reminder sender."""

from __future__ import annotations

from datetime import (
    datetime,
    time,
    timezone,
)
import json
import os
from pathlib import Path
from typing import Any
from zoneinfo import (
    ZoneInfo,
    ZoneInfoNotFoundError,
)

import psycopg
import urllib3

from database import options
from study_push_crypto import (
    encrypt_web_push,
    push_endpoint_allowed,
    vapid_authorization,
    vapid_private_key_from_string,
)


MAX_SUBSCRIPTIONS_PER_RUN = 5000
REMINDER_GRACE_SECONDS = (
    2 * 60 * 60
)
ADVISORY_LOCK_KEY = 51494611


def _required(
    env: dict[str, str],
    name: str,
    maximum: int,
) -> str:
    value = (
        env.get(name, "")
        .strip()
    )
    if (
        not value
        or len(value) > maximum
    ):
        raise ValueError(
            f"{name} is missing or invalid."
        )
    return value


def _local_date_due(
    *,
    now: datetime,
    reminder_time: time,
    timezone_name: str,
) -> tuple[bool, Any]:
    try:
        zone = ZoneInfo(
            timezone_name
        )
    except ZoneInfoNotFoundError:
        return False, None

    local_now = now.astimezone(
        zone
    )
    scheduled = datetime.combine(
        local_now.date(),
        reminder_time,
        tzinfo=zone,
    )
    delta = (
        local_now - scheduled
    ).total_seconds()

    return (
        0
        <= delta
        < REMINDER_GRACE_SECONDS,
        local_now.date(),
    )


def _payload(
    due_count: int,
) -> bytes:
    noun = (
        "card"
        if due_count == 1
        else "cards"
    )
    return json.dumps(
        {
            "title":
                "Study review ready",
            "body":
                f"You have {due_count} {noun} ready to review.",
            "url": "/decks",
        },
        separators=(",", ":"),
    ).encode("utf-8")


def _candidate_rows(
    connection,
):
    rows = connection.execute(
        """WITH due AS (
             SELECT user_id,count(user_id)::int AS due_count
             FROM app.cards
             WHERE due_at <= now()
             GROUP BY user_id
           )
           SELECT
             p.user_id,
             p.reminder_time,
             p.timezone,
             p.minimum_due_cards,
             coalesce(d.due_count,0)::int AS due_count,
             s.endpoint_hash,
             s.endpoint,
             s.p256dh,
             s.auth
           FROM app.study_notification_preferences p
           JOIN app.study_push_subscriptions s
             ON s.user_id=p.user_id
           LEFT JOIN due d
             ON d.user_id=p.user_id
           WHERE p.enabled=true
             AND coalesce(d.due_count,0) >= p.minimum_due_cards
           ORDER BY p.user_id,s.endpoint_hash
           LIMIT %s""",
        (
            MAX_SUBSCRIPTIONS_PER_RUN
            + 1,
        ),
    ).fetchall()

    if (
        len(rows)
        > MAX_SUBSCRIPTIONS_PER_RUN
    ):
        raise RuntimeError(
            "Notification candidate safety limit exceeded."
        )
    return rows


def _already_sent(
    connection,
    *,
    user_id,
    endpoint_hash: str,
    local_date,
) -> bool:
    return (
        connection.execute(
            """SELECT 1
               FROM app.study_notification_deliveries
               WHERE user_id=%s
                 AND endpoint_hash=%s
                 AND local_date=%s""",
            (
                user_id,
                endpoint_hash,
                local_date,
            ),
        ).fetchone()
        is not None
    )


def _mark_sent(
    connection,
    *,
    user_id,
    endpoint_hash: str,
    local_date,
    due_count: int,
) -> None:
    connection.execute(
        """INSERT INTO app.study_notification_deliveries(
             user_id,endpoint_hash,local_date,due_count
           ) VALUES (%s,%s,%s,%s)
           ON CONFLICT DO NOTHING""",
        (
            user_id,
            endpoint_hash,
            local_date,
            due_count,
        ),
    )


def _delete_expired(
    connection,
    endpoint_hash: str,
) -> None:
    connection.execute(
        """DELETE FROM app.study_push_subscriptions
           WHERE endpoint_hash=%s""",
        (
            endpoint_hash,
        ),
    )


def send_one(
    http: urllib3.PoolManager,
    *,
    endpoint: str,
    p256dh: str,
    auth: str,
    payload: bytes,
    vapid_private,
    vapid_subject: str,
) -> int:
    if not push_endpoint_allowed(
        endpoint
    ):
        return 400

    encrypted = encrypt_web_push(
        payload,
        p256dh=p256dh,
        auth=auth,
    )
    authorization = (
        vapid_authorization(
            vapid_private,
            endpoint=endpoint,
            subject=vapid_subject,
        )
    )

    response = http.request(
        "POST",
        endpoint,
        body=encrypted,
        headers={
            "Authorization":
                authorization,
            "Content-Encoding":
                "aes128gcm",
            "Content-Type":
                "application/octet-stream",
            "TTL": "3600",
        },
        timeout=urllib3.Timeout(
            connect=5.0,
            read=10.0,
        ),
        retries=False,
        preload_content=False,
    )
    try:
        return int(
            response.status
        )
    finally:
        response.release_conn()


def run(
    env: dict[str, str],
    *,
    now: datetime | None = None,
    http: urllib3.PoolManager
        | None = None,
) -> dict[str, int]:
    if (
        env.get(
            "PRODUCTION_DATABASE_TARGET"
        )
        != "lightsail"
        or env.get("PGUSER")
        != "quizforge_notifier"
    ):
        raise ValueError(
            "Study notifier requires the dedicated Lightsail database role."
        )

    private_value = _required(
        env,
        "WEB_PUSH_VAPID_PRIVATE_KEY",
        128,
    )
    subject = _required(
        env,
        "WEB_PUSH_VAPID_SUBJECT",
        512,
    )
    if not (
        subject.startswith(
            "https://"
        )
        or subject.startswith(
            "mailto:"
        )
    ):
        raise ValueError(
            "VAPID subject is invalid."
        )

    vapid_private = (
        vapid_private_key_from_string(
            private_value
        )
    )
    current = (
        datetime.now(timezone.utc)
        if now is None
        else now.astimezone(
            timezone.utc
        )
    )
    client = (
        urllib3.PoolManager()
        if http is None
        else http
    )

    summary = {
        "candidates": 0,
        "sent": 0,
        "skipped_time": 0,
        "skipped_duplicate": 0,
        "expired_removed": 0,
        "failed": 0,
    }

    with psycopg.connect(
        **options(env)
    ) as connection:
        locked = connection.execute(
            "SELECT pg_try_advisory_lock(%s) AS locked",
            (
                ADVISORY_LOCK_KEY,
            ),
        ).fetchone()["locked"]
        if not locked:
            return summary

        try:
            rows = _candidate_rows(
                connection
            )
            summary["candidates"] = (
                len(rows)
            )

            for row in rows:
                eligible, local_date = (
                    _local_date_due(
                        now=current,
                        reminder_time=
                            row[
                                "reminder_time"
                            ],
                        timezone_name=
                            row[
                                "timezone"
                            ],
                    )
                )
                if (
                    not eligible
                    or local_date
                    is None
                ):
                    summary[
                        "skipped_time"
                    ] += 1
                    continue

                if _already_sent(
                    connection,
                    user_id=
                        row["user_id"],
                    endpoint_hash=
                        row[
                            "endpoint_hash"
                        ],
                    local_date=
                        local_date,
                ):
                    summary[
                        "skipped_duplicate"
                    ] += 1
                    continue

                try:
                    status = send_one(
                        client,
                        endpoint=
                            row["endpoint"],
                        p256dh=
                            row["p256dh"],
                        auth=row["auth"],
                        payload=_payload(
                            row[
                                "due_count"
                            ]
                        ),
                        vapid_private=
                            vapid_private,
                        vapid_subject=
                            subject,
                    )
                except Exception:
                    summary[
                        "failed"
                    ] += 1
                    continue

                if (
                    200
                    <= status
                    < 300
                ):
                    _mark_sent(
                        connection,
                        user_id=
                            row["user_id"],
                        endpoint_hash=
                            row[
                                "endpoint_hash"
                            ],
                        local_date=
                            local_date,
                        due_count=
                            row["due_count"],
                    )
                    summary[
                        "sent"
                    ] += 1
                elif status in (
                    404,
                    410,
                ):
                    _delete_expired(
                        connection,
                        row[
                            "endpoint_hash"
                        ],
                    )
                    summary[
                        "expired_removed"
                    ] += 1
                else:
                    summary[
                        "failed"
                    ] += 1
        finally:
            connection.execute(
                "SELECT pg_advisory_unlock(%s)",
                (
                    ADVISORY_LOCK_KEY,
                ),
            )

    return summary


def main() -> int:
    try:
        result = run(
            dict(os.environ)
        )
        print(
            json.dumps(
                {
                    "format":
                        "quizforge-study-notifier-v1",
                    **result,
                },
                sort_keys=True,
            )
        )
        return 0
    except Exception as error:
        print(
            json.dumps(
                {
                    "format":
                        "quizforge-study-notifier-v1",
                    "error":
                        type(error).__name__,
                },
                sort_keys=True,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
