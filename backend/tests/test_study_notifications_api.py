import base64
from datetime import datetime, time, timezone
from uuid import UUID

from fastapi.testclient import TestClient
import pytest

import study_notifications
from main import app


class FakeRepository:
    def __init__(self):
        self.calls = []

    async def get(self):
        self.calls.append(("get",))
        return {
            "enabled": False,
            "reminder_time": time(19, 0),
            "timezone": "America/Toronto",
            "minimum_due_cards": 1,
        }

    async def save(self, payload):
        self.calls.append(("save", payload))
        return payload.model_dump()

    async def list_subscriptions(self):
        self.calls.append(("list_subscriptions",))
        return [
            {
                "id": UUID(
                    "11111111-1111-4111-8111-111111111111"
                ),
                "endpoint_sha256": "a" * 64,
                "failure_count": 0,
                "last_success_at": None,
                "created_at": datetime(
                    2026, 9, 28, 4, 0,
                    tzinfo=timezone.utc,
                ),
                "updated_at": datetime(
                    2026, 9, 28, 4, 0,
                    tzinfo=timezone.utc,
                ),
            }
        ]

    async def save_subscription(self, payload):
        self.calls.append(
            ("save_subscription", payload)
        )
        return (
            await self.list_subscriptions()
        )[0]

    async def delete_subscription(self, subscription_id):
        self.calls.append(
            ("delete_subscription", subscription_id)
        )


@pytest.fixture
def api():
    repository = FakeRepository()
    app.dependency_overrides[
        study_notifications.get_notification_repository
    ] = lambda: repository
    try:
        yield TestClient(app), repository
    finally:
        app.dependency_overrides.clear()


def test_preferences_require_authentication():
    response = TestClient(app).get(
        "/api/study-notifications/preferences"
    )
    assert response.status_code == 401


def test_default_preferences_are_returned(api):
    client, repository = api

    response = client.get(
        "/api/study-notifications/preferences"
    )

    assert response.status_code == 200
    assert response.json() == {
        "enabled": False,
        "reminder_time": "19:00:00",
        "timezone": "America/Toronto",
        "minimum_due_cards": 1,
    }
    assert repository.calls == [("get",)]


def test_update_preferences_validates_and_normalizes_timezone(api):
    client, repository = api

    response = client.put(
        "/api/study-notifications/preferences",
        json={
            "enabled": True,
            "reminder_time": "20:30",
            "timezone": " America/Toronto ",
            "minimum_due_cards": 3,
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "enabled": True,
        "reminder_time": "20:30:00",
        "timezone": "America/Toronto",
        "minimum_due_cards": 3,
    }
    _, payload = repository.calls[0]
    assert payload.timezone == "America/Toronto"
    assert payload.reminder_time == time(20, 30)


@pytest.mark.parametrize(
    "payload",
    [
        {
            "enabled": True,
            "reminder_time": "20:30",
            "timezone": "Not/A_Real_Zone",
            "minimum_due_cards": 1,
        },
        {
            "enabled": True,
            "reminder_time": "25:00",
            "timezone": "America/Toronto",
            "minimum_due_cards": 1,
        },
        {
            "enabled": True,
            "reminder_time": "20:30",
            "timezone": "America/Toronto",
            "minimum_due_cards": 0,
        },
        {
            "enabled": True,
            "reminder_time": "20:30",
            "timezone": "America/Toronto",
            "minimum_due_cards": 1001,
        },
        {
            "enabled": True,
            "reminder_time": "20:30",
            "timezone": "America/Toronto",
            "minimum_due_cards": 1,
            "user_id": "forged",
        },
    ],
)
def test_invalid_preferences_are_rejected_before_repository(api, payload):
    client, repository = api

    response = client.put(
        "/api/study-notifications/preferences",
        json=payload,
    )

    assert response.status_code == 422
    assert repository.calls == []


def test_put_preflight_preserves_origin_allowlist(monkeypatch):
    monkeypatch.setenv(
        "ALLOWED_ORIGINS",
        "https://frontend.example",
    )
    from app_shared import create_app

    local = create_app()
    local.include_router(
        study_notifications.router
    )
    client = TestClient(local)
    headers = {
        "Origin": "https://frontend.example",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers":
            "authorization,content-type",
    }

    allowed = client.options(
        "/api/study-notifications/preferences",
        headers=headers,
    )
    assert allowed.status_code == 200
    assert (
        allowed.headers[
            "Access-Control-Allow-Origin"
        ]
        == "https://frontend.example"
    )

def valid_vapid_public_key():
    raw = bytes([4]) + bytes(range(1, 65))
    return (
        base64.urlsafe_b64encode(raw)
        .decode()
        .rstrip("=")
    )


def test_vapid_public_key_requires_authentication(monkeypatch):
    monkeypatch.setenv(
        "WEB_PUSH_VAPID_PUBLIC_KEY",
        valid_vapid_public_key(),
    )
    response = TestClient(app).get(
        "/api/study-notifications/vapid-public-key"
    )
    assert response.status_code == 401


def test_vapid_public_key_is_returned_for_signed_in_user(api, monkeypatch):
    client, _ = api
    value = valid_vapid_public_key()
    monkeypatch.setenv(
        "WEB_PUSH_VAPID_PUBLIC_KEY",
        value,
    )

    response = client.get(
        "/api/study-notifications/vapid-public-key"
    )

    assert response.status_code == 200
    assert response.json() == {
        "public_key": value,
    }


@pytest.mark.parametrize(
    "value",
    [
        "",
        "not-base64",
        "A" * 87,
    ],
)
def test_invalid_vapid_configuration_fails_closed(api, monkeypatch, value):
    client, _ = api
    monkeypatch.setenv(
        "WEB_PUSH_VAPID_PUBLIC_KEY",
        value,
    )

    response = client.get(
        "/api/study-notifications/vapid-public-key"
    )

    assert response.status_code == 503


def test_push_subscription_crud_uses_only_validated_payload(api):
    client, repository = api

    listed = client.get(
        "/api/study-notifications/subscriptions"
    )
    assert listed.status_code == 200
    assert listed.json()[0]["endpoint_sha256"] == "a" * 64

    payload = {
        "endpoint":
            "https://push.example/subscription",
        "keys": {
            "p256dh": "B" * 64,
            "auth": "C" * 24,
        },
    }
    saved = client.post(
        "/api/study-notifications/subscriptions",
        json=payload,
    )
    assert saved.status_code == 201

    deleted = client.delete(
        "/api/study-notifications/subscriptions/"
        "11111111-1111-4111-8111-111111111111"
    )
    assert deleted.status_code == 204

    assert repository.calls[0] == (
        "list_subscriptions",
    )
    assert repository.calls[1][0] == (
        "save_subscription"
    )
    assert (
        repository.calls[1][1].endpoint
        == payload["endpoint"]
    )
    assert repository.calls[-1] == (
        "delete_subscription",
        UUID(
            "11111111-1111-4111-8111-111111111111"
        ),
    )


@pytest.mark.parametrize(
    "payload",
    [
        {
            "endpoint": "http://push.example/sub",
            "keys": {
                "p256dh": "B" * 64,
                "auth": "C" * 24,
            },
        },
        {
            "endpoint":
                "https://user:pass@push.example/sub",
            "keys": {
                "p256dh": "B" * 64,
                "auth": "C" * 24,
            },
        },
        {
            "endpoint":
                "https://push.example/sub#fragment",
            "keys": {
                "p256dh": "B" * 64,
                "auth": "C" * 24,
            },
        },
        {
            "endpoint":
                "https://push.example/sub",
            "keys": {
                "p256dh": "bad!",
                "auth": "C" * 24,
            },
        },
        {
            "endpoint":
                "https://push.example/sub",
            "keys": {
                "p256dh": "B" * 64,
                "auth": "bad!",
            },
        },
        {
            "endpoint":
                "https://push.example/sub",
            "keys": {
                "p256dh": "B" * 64,
                "auth": "C" * 24,
            },
            "user_id": "forged",
        },
    ],
)
def test_invalid_push_subscriptions_are_rejected_before_repository(api, payload):
    client, repository = api

    response = client.post(
        "/api/study-notifications/subscriptions",
        json=payload,
    )

    assert response.status_code == 422
    assert repository.calls == []

