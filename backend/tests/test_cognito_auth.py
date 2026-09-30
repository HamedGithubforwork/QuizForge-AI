import asyncio
import time
from uuid import UUID

from fastapi import HTTPException
import httpx
import jwt
import pytest

import app_shared
from cognito_auth import (CognitoSettings, CognitoVerifier, KEY_TTL_SECONDS, MAX_RESPONSE_BYTES,
                          auth_provider, validate_auth_configuration)


def test_verified_access_token_has_provider_namespaced_identity(cognito, monkeypatch):
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(cognito.handler)) as client:
            async def get_client(): return client
            monkeypatch.setattr(app_shared, "get_http_client", get_client)
            user = await app_shared.get_current_user("Bearer " + cognito.sign())
            assert user.provider == "cognito" and user.issuer == cognito.settings.issuer
            assert user.subject == str(UUID(int=101))
            assert user.id == f"cognito:{cognito.settings.pool_id}:{user.subject}"
            assert len(cognito.calls) == 2
    asyncio.run(scenario())


@pytest.mark.parametrize("changes,omit", [
    ({"iss": "https://attacker.invalid"}, ()), ({"client_id": "another-client"}, ()),
    ({"token_use": "id"}, ()), ({"scope": "openid email"}, ()),
    ({"aud": "unconfigured-resource"}, ()), ({"sub": "not-a-uuid"}, ()),
    ({"sub": 3}, ()), ({"exp": 1}, ()), ({"iat": 4_000_000_000}, ()),
    ({"iat": True}, ()), ({"iat": "12"}, ()), ({"auth_time": 4_000_000_000}, ()),
    ({"exp": int(time.time()) + 7200}, ()), ({"scope": ["aws.cognito.signin.user.admin"]}, ()),
    *[({}, (name,)) for name in ("exp", "iat", "auth_time", "iss", "sub", "client_id", "scope", "token_use")],
])
def test_rejects_invalid_claims_before_online_user_call(cognito, changes, omit):
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(cognito.handler)) as client:
            with pytest.raises(HTTPException) as error:
                await CognitoVerifier(cognito.settings).verify(cognito.sign(changes=changes, omit=omit), client)
            assert error.value.status_code == 401
            assert all(request.method == "GET" for request in cognito.calls)
    asyncio.run(scenario())


@pytest.mark.parametrize("kind", ["malformed", "oversized", "unsigned", "hmac", "bad-signature", "jku", "jwk", "x5u", "crit", "missing-kid"])
def test_rejects_algorithm_confusion_and_untrusted_keys(cognito, kind):
    token = cognito.sign()
    if kind == "malformed": token = "invalid"
    elif kind == "oversized": token = "x" * 16_385
    elif kind == "unsigned": token = jwt.encode({"sub": "owner"}, "", algorithm="none", headers={"kid": "key-0"})
    elif kind == "hmac": token = jwt.encode({"sub": "owner"}, "attacker-key-not-a-trusted-rsa-key!!", algorithm="HS256", headers={"kid": "key-0"})
    elif kind == "bad-signature": token = cognito.sign(key=2, header={"kid": "key-0"})
    elif kind == "missing-kid": token = cognito.sign(header={"typ": "JWT"})
    else: token = cognito.sign(header={"kid": "key-0", kind: "https://attacker.invalid/key"})
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(cognito.handler)) as client:
            with pytest.raises(HTTPException) as error:
                await CognitoVerifier(cognito.settings).verify(token, client)
            assert error.value.status_code == 401
            assert len(cognito.calls) == (1 if kind == "bad-signature" else 0)
    asyncio.run(scenario())


def test_rotation_cooldown_cache_expiry_and_singleflight(cognito, monkeypatch):
    async def scenario():
        verifier = CognitoVerifier(cognito.settings)
        clock = [1000.0]
        monkeypatch.setattr("cognito_auth.time.monotonic", lambda: clock[0])
        async with httpx.AsyncClient(transport=httpx.MockTransport(cognito.handler)) as client:
            await asyncio.gather(*[verifier.verify(cognito.sign(), client) for _ in range(8)])
            assert len([r for r in cognito.calls if r.method == "GET"]) == 1
            assert len([r for r in cognito.calls if r.method == "POST"]) == 8
            cognito.published = [0, 1]
            with pytest.raises(HTTPException) as error:
                await verifier.verify(cognito.sign(key=1), client)
            assert error.value.status_code == 401
            clock[0] += 31
            await verifier.verify(cognito.sign(key=1), client)
            assert len([r for r in cognito.calls if r.method == "GET"]) == 2
            # Retired keys cannot survive beyond the bounded key cache.
            clock[0] += KEY_TTL_SECONDS + 1
            cognito.published = [1]
            with pytest.raises(HTTPException) as error:
                await verifier.verify(cognito.sign(), client)
            assert error.value.status_code == 401
            assert len([r for r in cognito.calls if r.method == "GET"]) == 3
    asyncio.run(scenario())


@pytest.mark.parametrize("status,payload,expected", [
    (400, {"__type": "NotAuthorizedException", "message": "private-service-detail"}, 401),
    (400, {"__type": "UserNotConfirmedException"}, 401),
    (400, {"__type": "PasswordResetRequiredException"}, 401),
    (400, {"__type": "TooManyRequestsException"}, 503), (500, {}, 503),
    (200, {"UserAttributes": [{"Name": "sub", "Value": "other-owner"}]}, 401),
    (200, {"UserAttributes": []}, 401), (200, {"UserAttributes": None}, 503),
    (200, [], 503), (302, {}, 503),
])
def test_online_rejections_outages_and_subject_mismatch_fail_closed(cognito, status, payload, expected):
    cognito.response = httpx.Response(status, json=payload)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(cognito.handler)) as client:
            with pytest.raises(HTTPException) as error:
                await CognitoVerifier(cognito.settings).verify(cognito.sign(), client)
            assert error.value.status_code == expected and "private-service-detail" not in error.value.detail
    asyncio.run(scenario())


def test_revocation_is_checked_even_with_a_cached_signing_key(cognito):
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(cognito.handler)) as client:
            verifier, token = CognitoVerifier(cognito.settings), cognito.sign()
            await verifier.verify(token, client)
            cognito.response = httpx.Response(400, json={"__type": "NotAuthorizedException"})
            with pytest.raises(HTTPException) as error: await verifier.verify(token, client)
            assert error.value.status_code == 401
            assert [r.method for r in cognito.calls] == ["GET", "POST", "POST"]
    asyncio.run(scenario())


@pytest.mark.parametrize("response", [httpx.Response(200, content="not-json"),
    httpx.Response(200, content="x" * (MAX_RESPONSE_BYTES + 1)),
    httpx.Response(302, json={}, headers={"Location": "https://attacker.invalid"}),
    httpx.Response(200, json={"keys": []}), httpx.Response(200, json={"keys": [{"kty": "oct"}]})])
def test_unusable_jwks_has_no_stale_or_remote_fallback(cognito, response):
    async def scenario():
        calls = []
        def handler(request):
            calls.append(request)
            return response
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            verifier = CognitoVerifier(cognito.settings)
            for _ in range(3):
                with pytest.raises(HTTPException) as error: await verifier.verify(cognito.sign(), client)
                assert error.value.status_code == 503
            assert len(calls) == 1
    asyncio.run(scenario())


def test_unverified_email_does_not_authorize_signup(cognito):
    token = cognito.sign()
    cognito.attributes = [{"Name": "sub", "Value": cognito.tokens[token]},
                          {"Name": "email", "Value": "same-email@example.invalid"},
                          {"Name": "email_verified", "Value": "false"}]
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(cognito.handler)) as client:
            with pytest.raises(HTTPException) as error:
                await CognitoVerifier(cognito.settings).verify(token, client)
            assert error.value.status_code == 403
    asyncio.run(scenario())


def test_supabase_default_preserves_existing_online_validation(monkeypatch):
    monkeypatch.delenv("AUTH_PROVIDER", raising=False)
    monkeypatch.setattr(app_shared, "SUPABASE_URL", "https://supabase.test")
    monkeypatch.setattr(app_shared, "SUPABASE_PUBLISHABLE_KEY", "publishable")
    async def scenario():
        def handler(request):
            assert str(request.url) == "https://supabase.test/auth/v1/user"
            assert request.headers["Authorization"] == "Bearer original-token"
            return httpx.Response(200, json={"id": "existing-subject", "email": "user@example.invalid"})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            async def get_client(): return client
            monkeypatch.setattr(app_shared, "get_http_client", get_client)
            user = await app_shared.get_current_user("Bearer original-token")
            assert user.id == user.subject == "existing-subject" and user.provider == "supabase"
            assert user.issuer == "https://supabase.test/auth/v1"
    asyncio.run(scenario())


def test_invalid_provider_and_incompatible_history_fail_before_startup(monkeypatch):
    monkeypatch.setenv("AUTH_PROVIDER", "typo")
    with pytest.raises(RuntimeError): auth_provider()
    for pool in ("http://attacker", "us-east-1_Other", "ca-central-1_Ok/../Other"):
        with pytest.raises(RuntimeError): CognitoSettings(pool, "client123")
    monkeypatch.setenv("AUTH_PROVIDER", "cognito")
    monkeypatch.setenv("COGNITO_USER_POOL_ID", "ca-central-1_TestPool")
    monkeypatch.setenv("COGNITO_CLIENT_ID", "client123")
    monkeypatch.setenv("HISTORY_BACKEND", "supabase")
    with pytest.raises(RuntimeError, match="PostgreSQL history"): validate_auth_configuration()


@pytest.mark.parametrize("enabled,client_id,accepted", [
    (False, "client123", True), (False, "desktop123", False),
    (True, "client123", True), (True, "desktop123", True), (True, "other123", False),
    (True, ["desktop123"], False), (True, None, False),
])
def test_desktop_client_is_explicit_opt_in_and_preserves_web_identity(cognito, enabled, client_id, accepted):
    settings = CognitoSettings(cognito.settings.pool_id, cognito.settings.client_id,
                               "desktop123" if enabled else "")
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(cognito.handler)) as client:
            token = cognito.sign(changes={"client_id": client_id})
            if accepted:
                subject, email = await CognitoVerifier(settings).verify(token, client)
                assert subject == str(UUID(int=101)) and email == "same-email@example.invalid"
                assert [request.method for request in cognito.calls] == ["GET", "POST"]
            else:
                with pytest.raises(HTTPException) as error:
                    await CognitoVerifier(settings).verify(token, client)
                assert error.value.status_code == 401
                assert all(request.method == "GET" for request in cognito.calls)
    asyncio.run(scenario())


@pytest.mark.parametrize("changes", [{"token_use": "id"}, {"iss": "https://attacker.invalid"},
                                      {"exp": 1}, {"scope": "openid email"}, {"aud": "other"}])
def test_allowed_desktop_client_still_requires_valid_access_claims(cognito, changes):
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(cognito.handler)) as client:
            verifier = CognitoVerifier(CognitoSettings(cognito.settings.pool_id, cognito.settings.client_id, "desktop123"))
            with pytest.raises(HTTPException) as error:
                await verifier.verify(cognito.sign(changes={"client_id": "desktop123", **changes}), client)
            assert error.value.status_code == 401
            assert all(request.method == "GET" for request in cognito.calls)
    asyncio.run(scenario())


def test_desktop_revocation_is_checked_with_cached_signing_key(cognito):
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(cognito.handler)) as client:
            verifier = CognitoVerifier(CognitoSettings(cognito.settings.pool_id, cognito.settings.client_id, "desktop123"))
            token = cognito.sign(changes={"client_id": "desktop123"})
            await verifier.verify(token, client)
            cognito.response = httpx.Response(400, json={"__type": "NotAuthorizedException"})
            with pytest.raises(HTTPException) as error:
                await verifier.verify(token, client)
            assert error.value.status_code == 401
            assert [r.method for r in cognito.calls] == ["GET", "POST", "POST"]
    asyncio.run(scenario())


def test_desktop_configuration_is_off_by_default_and_rejects_ambiguous_values(cognito, monkeypatch):
    monkeypatch.delenv("COGNITO_DESKTOP_CLIENT_ID", raising=False)
    assert CognitoSettings.from_environment().accepted_client_ids == ("client123",)
    monkeypatch.setenv("COGNITO_DESKTOP_CLIENT_ID", "desktop123")
    assert CognitoSettings.from_environment().accepted_client_ids == ("client123", "desktop123")
    for value in ("client123", "*", "desktop123,other123", " desktop123", "a" * 129):
        monkeypatch.setenv("COGNITO_DESKTOP_CLIENT_ID", value)
        with pytest.raises(RuntimeError, match="distinct explicit app client"):
            CognitoSettings.from_environment()
