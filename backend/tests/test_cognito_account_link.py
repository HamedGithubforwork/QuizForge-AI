"""Regression checks: separate, fresh Cognito identities are both required for linking."""
import asyncio
from types import SimpleNamespace
from uuid import UUID

from fastapi import HTTPException
import httpx
import pytest

import identity_app
from identity_proofs import Identity, cognito_link_proof


CURRENT = str(UUID(int=11))
EXISTING = str(UUID(int=22))
ISSUER = "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Test"
ORIGIN = "https://quizfromnotes.com"


class Verifier:
    def __init__(self):
        self.calls = []

    async def verify(self, token, client, *, max_auth_age=None):
        self.calls.append((token, max_auth_age))
        if token == "new-google":
            return CURRENT, "same@example.test"
        if token == "existing-local":
            return EXISTING, "same@example.test"
        if token == "same-account":
            return CURRENT, "same@example.test"
        raise HTTPException(401, "The existing account could not be verified.")


def test_cognito_link_requires_fresh_independent_online_proof():
    verifier = Verifier()
    async def scenario():
        result = await cognito_link_proof("Bearer existing-local", verifier, object(), ISSUER, CURRENT)
        assert result == Identity(ISSUER, EXISTING)
        for value in (None, "", "token", "Bearer ", "Bearer " + "x" * 16_385):
            with pytest.raises(HTTPException) as error:
                await cognito_link_proof(value, verifier, object(), ISSUER, CURRENT)
            assert error.value.status_code == 401
        with pytest.raises(HTTPException) as error:
            await cognito_link_proof("Bearer same-account", verifier, object(), ISSUER, CURRENT)
        assert error.value.status_code == 409
        with pytest.raises(HTTPException) as error:
            await cognito_link_proof("Bearer forged", verifier, object(), ISSUER, CURRENT)
        assert error.value.status_code == 401
    asyncio.run(scenario())
    assert verifier.calls == [("existing-local", 300), ("same-account", 300), ("forged", 300)]


def test_identity_service_challenge_and_confirm_require_both_cognito_proofs(monkeypatch):
    verifier = Verifier()
    entries = []
    confirmations = []
    monkeypatch.setattr(identity_app, "settings", lambda: (ORIGIN, "https://legacy.test", "publishable"))
    monkeypatch.setattr(identity_app.CognitoSettings, "from_environment",
                        lambda: SimpleNamespace(issuer=ISSUER, pool_id="ca-central-1_Test"))
    monkeypatch.setattr(identity_app, "verifier_for", lambda _: verifier)

    class Repository:
        def __init__(self, pool, cognito, existing=None):
            entries.append((cognito, existing))
        async def challenge(self, mode):
            assert mode == "link"
            return "a" * 43
        async def confirm(self, nonce, mode):
            confirmations.append((nonce, mode))

    monkeypatch.setattr(identity_app, "IdentityRepository", Repository)
    app = identity_app.create_identity_app()
    app.state.pool, app.state.http = object(), object()

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://api.test") as client:
            headers = {"Origin": ORIGIN, "Authorization": "Bearer new-google",
                       "X-Cognito-Link-Authorization": "Bearer existing-local"}
            response = await client.post("/identity/challenge", json={"mode": "link"}, headers=headers)
            assert response.status_code == 200, response.text
            assert response.json() == {"nonce": "a" * 43, "expires_in": 300}
            response = await client.post("/identity/confirm", json={"mode": "link", "nonce": "a" * 43},
                                         headers=headers)
            assert response.status_code == 204, response.text
            assert entries == [(Identity(ISSUER, CURRENT), Identity(ISSUER, EXISTING))] * 2
            assert confirmations == [("a" * 43, "link")]
            assert verifier.calls == [("new-google", 300), ("existing-local", 300)] * 2

            # Neither equal emails nor a forged second bearer prove ownership.
            for second in ("Bearer forged", "Bearer same-account", "token"):
                response = await client.post("/identity/challenge", json={"mode": "link"},
                    headers={**headers, "X-Cognito-Link-Authorization": second})
                assert response.status_code in (400, 401, 409)
            response = await client.post("/identity/challenge", json={"mode": "enroll"}, headers=headers)
            assert response.status_code == 400
            response = await client.post("/identity/challenge", json={"mode": "link"},
                headers={**headers, "X-Legacy-Authorization": "Bearer legacy"})
            assert response.status_code == 400
            response = await client.post("/identity/challenge", json={"mode": "link"},
                headers={**headers, "Origin": "https://other.example.test"})
            assert response.status_code == 403
            assert len(entries) == 2  # Failed proofs never reach enrollment storage.
    asyncio.run(scenario())
