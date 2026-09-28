from datetime import datetime, time, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

import pytest
from pywebpush import WebPushException

from study_notification_sender import (
    ReminderCandidate,
    delivery_window,
    payload,
    push_configuration,
    push_once,
)


NOW = datetime(
    2026,
    9,
    28,
    0,
    30,
    tzinfo=timezone.utc,
)
USER = str(
    UUID(
        "11111111-1111-4111-8111-111111111111"
    )
)


def candidate(**changes):
    return ReminderCandidate(
        user_id=USER,
        reminder_time=time(
            20,
            0,
        ),
        timezone_name=
            "America/Toronto",
        minimum_due_cards=1,
        endpoint_hash="a" * 64,
        endpoint=
            "https://push.example/subscription",
        p256dh="p" * 32,
        auth="auth-token",
        due_count=3,
        **changes,
    )


def test_delivery_window_uses_users_local_timezone():
    window = delivery_window(
        time(20, 0),
        "America/Toronto",
        NOW,
    )

    assert window.eligible is True
    assert (
        window.local_date
        .isoformat()
        == "2026-09-27"
    )

    earlier = delivery_window(
        time(21, 0),
        "America/Toronto",
        NOW,
    )
    assert earlier.eligible is False


def test_invalid_timezone_fails_closed():
    result = delivery_window(
        time(19, 0),
        "Not/A_Zone",
        NOW,
    )

    assert result.eligible is False


def test_payload_contains_only_due_count_and_decks_link():
    data = payload(3)

    assert '"3 study cards"' not in data
    assert (
        "You have 3 study cards ready to review."
        in data
    )
    assert '"url":"/decks"' in data
    assert "question" not in data.lower()
    assert "answer" not in data.lower()


@pytest.mark.parametrize(
    "private_key,subject",
    [
        (
            "short",
            "mailto:user@example.com",
        ),
        (
            "A" * 90,
            "https://example.com",
        ),
    ],
)
def test_push_configuration_fails_closed(
    private_key,
    subject,
):
    with pytest.raises(
        ValueError
    ):
        push_configuration(
            {
                "WEB_PUSH_VAPID_PRIVATE_KEY":
                    private_key,
                "WEB_PUSH_VAPID_SUBJECT":
                    subject,
            }
        )


class FakeTransaction:
    def __enter__(self):
        return self

    def __exit__(
        self,
        exc_type,
        exc,
        traceback,
    ):
        return False


class FakeResult:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(
        self,
        *,
        delivered=False,
        locked=True,
    ):
        self.delivered = delivered
        self.locked = locked
        self.inserts = []
        self.deletes = []

    def transaction(self):
        return FakeTransaction()

    def execute(
        self,
        query,
        params=(),
    ):
        sql = " ".join(
            str(query).split()
        )

        if (
            "pg_try_advisory_xact_lock"
            in sql
        ):
            return FakeResult(
                (self.locked,)
            )

        if (
            "FROM app.study_notification_deliveries"
            in sql
        ):
            return FakeResult(
                (1,)
                if self.delivered
                else None
            )

        if (
            sql.startswith(
                "INSERT INTO app.study_notification_deliveries"
            )
        ):
            self.inserts.append(
                params
            )
            return FakeResult(None)

        if (
            sql.startswith(
                "DELETE FROM app.study_push_subscriptions"
            )
        ):
            self.deletes.append(
                params
            )
            return FakeResult(None)

        raise AssertionError(
            sql
        )


def test_successful_push_is_logged_once():
    connection = FakeConnection()
    calls = []

    def send(**kwargs):
        calls.append(kwargs)

    result = push_once(
        connection,
        candidate(),
        NOW.date(),
        private_key="A" * 90,
        subject=
            "mailto:user@example.com",
        send=send,
    )

    assert result == "sent"
    assert len(calls) == 1
    assert len(connection.inserts) == 1
    assert connection.deletes == []


def test_existing_delivery_never_sends_again():
    connection = FakeConnection(
        delivered=True
    )
    calls = []

    result = push_once(
        connection,
        candidate(),
        NOW.date(),
        private_key="A" * 90,
        subject=
            "mailto:user@example.com",
        send=lambda **kwargs:
            calls.append(kwargs),
    )

    assert result == "duplicate"
    assert calls == []
    assert connection.inserts == []


def web_push_error(
    status_code,
):
    error = WebPushException(
        "synthetic",
        response=SimpleNamespace(
            status_code=status_code,
        ),
    )
    error.status_code = (
        status_code
    )
    return error


@pytest.mark.parametrize(
    "status,outcome,deleted",
    [
        (404, "expired", True),
        (410, "expired", True),
        (429, "retry", False),
        (503, "retry", False),
        (400, "failed", False),
    ],
)
def test_push_failures_have_bounded_outcomes(
    status,
    outcome,
    deleted,
):
    connection = FakeConnection()

    def send(**_kwargs):
        raise web_push_error(
            status
        )

    result = push_once(
        connection,
        candidate(),
        NOW.date(),
        private_key="A" * 90,
        subject=
            "mailto:user@example.com",
        send=send,
    )

    assert result == outcome
    assert bool(
        connection.deletes
    ) is deleted
    assert connection.inserts == []


def test_overlapping_sender_does_not_send():
    connection = FakeConnection(
        locked=False
    )
    calls = []

    result = push_once(
        connection,
        candidate(),
        NOW.date(),
        private_key="A" * 90,
        subject=
            "mailto:user@example.com",
        send=lambda **kwargs:
            calls.append(kwargs),
    )

    assert result == "locked"
    assert calls == []
