"""Production refusal, staging-only budget and exact exhaustion classification."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import application
from quiz_service import is_staging_budget_exhausted


class FakeRedis:
    def __init__(self, value, error=False):
        self.value = value
        self.error = error
        self.read_keys = []

    async def get(self, key):
        self.read_keys.append(key)
        if self.error:
            raise RuntimeError("secret internal connection detail")
        return self.value


def get_status():
    return asyncio.run(application.staging_ai_budget(
        _current_user=application.AuthenticatedUser(id="test-staging-user")
    ))


def test_staging_budget_is_readonly_and_production_hidden(monkeypatch):
    redis = FakeRedis(b"9")
    monkeypatch.setattr(application, "redis_client", redis)
    monkeypatch.setenv("OPENAI_API_KEY", "actual-production-test-key")
    with pytest.raises(HTTPException) as caught:
        get_status()
    assert caught.value.status_code == 404
    assert redis.read_keys == []
    monkeypatch.setenv("OPENAI_API_KEY", "staging-budget-guard")
    assert get_status() == {"remaining": 9, "allowance": 10}
    assert redis.read_keys == ["integration:openai:remaining"]
    redis.value = b"0"
    assert get_status() == {"remaining": 0, "allowance": 10}


@pytest.mark.parametrize("bad", [None, b"-1", b"11", b"unknown", b"1.5", b""])
def test_missing_or_invalid_staging_budget_fails_closed(monkeypatch, bad):
    monkeypatch.setenv("OPENAI_API_KEY", "staging-budget-guard")
    monkeypatch.setattr(application, "redis_client", FakeRedis(bad))
    with pytest.raises(HTTPException) as caught:
        get_status()
    assert caught.value.status_code == 503
    assert caught.value.detail == "Staging allowance unavailable."


def test_cache_failure_never_exposes_error_text(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "staging-budget-guard")
    monkeypatch.setattr(application, "redis_client", FakeRedis(None, error=True))
    with pytest.raises(HTTPException) as caught:
        get_status()
    assert caught.value.status_code == 503
    assert "secret" not in caught.value.detail


def test_staging_budget_error_cannot_be_forged_by_provider(monkeypatch):
    err = SimpleNamespace(
        status_code=429,
        response=SimpleNamespace(headers={"X-QuizForge-Staging-Budget": "exhausted"}),
    )
    assert is_staging_budget_exhausted(err, "staging-budget-guard")
    assert not is_staging_budget_exhausted(err, "production-key")
    assert not is_staging_budget_exhausted(
        SimpleNamespace(status_code=429, response=SimpleNamespace(headers={})),
        "staging-budget-guard",
    )
    assert not is_staging_budget_exhausted(
        SimpleNamespace(status_code=502, response=err.response),
        "staging-budget-guard",
    )
