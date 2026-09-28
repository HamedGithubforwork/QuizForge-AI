from datetime import time

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

    async def save_subscription(
        self,
        *,
        endpoint,
        p256dh,
        auth,
        user_agent,
    ):
        self.calls.append(
            (
                "save_subscription",
                endpoint,
                p256dh,
                auth,
                user_agent,
            )
        )
        return {
            "endpoint_hash": "a" * 64,
        }

    async def delete_subscription(
        self,
        endpoint_hash,
    ):
        self.calls.append(
            (
                "delete_subscription",
                endpoint_hash,
            )
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

def test_push_public_key_requires_valid_configuration(monkeypatch):
    client = TestClient(app)

    monkeypatch.delenv(
        "WEB_PUSH_VAPID_PUBLIC_KEY",
        raising=False,
    )
    app.dependency_overrides[
        study_notifications.get_current_user
    ] = lambda: study_notifications.AuthenticatedUser(
        id="synthetic",
        email="user@example.invalid",
        issuer="https://issuer.invalid",
        subject="subject",
    )
    try:
        response = client.get(
            "/api/study-notifications/push/public-key"
        )
        assert response.status_code == 503

        monkeypatch.setenv(
            "WEB_PUSH_VAPID_PUBLIC_KEY",
            "A" * 87,
        )
        response = client.get(
            "/api/study-notifications/push/public-key"
        )
        assert response.status_code == 200
        assert response.json() == {
            "public_key": "A" * 87,
        }
    finally:
        app.dependency_overrides.clear()


def test_register_push_subscription_uses_request_user_agent(api):
    client, repository = api

    response = client.post(
        "/api/study-notifications/push/subscriptions",
        headers={
            "User-Agent":
                "Synthetic Browser/1.0",
        },
        json={
            "endpoint":
                "https://push.example/subscription-1",
            "p256dh": "p" * 32,
            "auth": "auth-token",
        },
    )

    assert response.status_code == 201
    assert response.json() == {
        "endpoint_hash": "a" * 64,
    }
    assert repository.calls == [
        (
            "save_subscription",
            "https://push.example/subscription-1",
            "p" * 32,
            "auth-token",
            "Synthetic Browser/1.0",
        )
    ]


@pytest.mark.parametrize(
    "payload",
    [
        {
            "endpoint": "http://push.example/subscription",
            "p256dh": "p" * 32,
            "auth": "auth-token",
        },
        {
            "endpoint":
                "https://push.example/subscription",
            "p256dh": "contains padding=",
            "auth": "auth-token",
        },
        {
            "endpoint":
                "https://push.example/subscription",
            "p256dh": "p" * 32,
            "auth": "bad value!",
        },
        {
            "endpoint":
                "https://push.example/subscription",
            "p256dh": "p" * 32,
            "auth": "auth-token",
            "user_id": "forged",
        },
    ],
)
def test_invalid_push_subscriptions_are_rejected_before_repository(
    api,
    payload,
):
    client, repository = api

    response = client.post(
        "/api/study-notifications/push/subscriptions",
        json=payload,
    )

    assert response.status_code == 422
    assert repository.calls == []


def test_unregister_push_subscription_is_idempotent(api):
    client, repository = api

    response = client.delete(
        "/api/study-notifications/push/subscriptions/"
        + "b" * 64
    )

    assert response.status_code == 204
    assert repository.calls == [
        (
            "delete_subscription",
            "b" * 64,
        )
    ]

    invalid = client.delete(
        "/api/study-notifications/push/subscriptions/not-a-hash"
    )
    assert invalid.status_code == 422
    assert len(repository.calls) == 1

