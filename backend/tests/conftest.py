"""Synthetic Cognito issuer: real RSA signatures, mocked public AWS HTTP only."""
import json
import time
from types import SimpleNamespace
from uuid import UUID

from cryptography.hazmat.primitives.asymmetric import rsa
import httpx
import jwt
import pytest

from cognito_auth import CognitoSettings, USER_SCOPE, verifier_for


@pytest.fixture(scope="session")
def cognito_keys():
    return [rsa.generate_private_key(public_exponent=65537, key_size=2048) for _ in range(3)]


@pytest.fixture
def cognito(monkeypatch, cognito_keys):
    settings = CognitoSettings("ca-central-1_TestPool", "client123")
    state = SimpleNamespace(settings=settings, calls=[], published=[0], response=None, tokens={},
                            attributes=None, keys=cognito_keys)

    def sign(subject=str(UUID(int=101)), *, changes=None, omit=(), key=0, header=None):
        now = int(time.time())
        claims = {"sub": subject, "iss": settings.issuer, "client_id": settings.client_id,
                  "token_use": "access", "scope": USER_SCOPE, "iat": now - 10,
                  "auth_time": now - 20, "exp": now + 290}
        claims.update(changes or {})
        for name in omit:
            claims.pop(name, None)
        token = jwt.encode(claims, cognito_keys[key], algorithm="RS256", headers=header or {"kid": f"key-{key}"})
        state.tokens[token] = subject
        return token

    def handler(request):
        state.calls.append(request)
        if request.method == "GET":
            assert str(request.url) == settings.issuer + "/.well-known/jwks.json"
            keys = [{**json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(cognito_keys[i].public_key())),
                     "kid": f"key-{i}", "alg": "RS256", "use": "sig"} for i in state.published]
            return httpx.Response(200, json={"keys": keys})
        assert str(request.url) == settings.endpoint
        assert request.headers["X-Amz-Target"] == "AWSCognitoIdentityProviderService.GetUser"
        assert "authorization" not in request.headers
        if state.response is not None:
            return state.response
        token = json.loads(request.content)["AccessToken"]
        subject = state.tokens[token]
        attrs = state.attributes if state.attributes is not None else [
            {"Name": "sub", "Value": subject}, {"Name": "email", "Value": "same-email@example.invalid"},
            {"Name": "email_verified", "Value": "true"}]
        return httpx.Response(200, json={"Username": "not-an-owner", "UserAttributes": attrs})

    state.sign, state.handler = sign, handler
    verifier_for.cache_clear()
    for name, value in {"AUTH_PROVIDER": "cognito", "COGNITO_USER_POOL_ID": settings.pool_id,
                        "COGNITO_CLIENT_ID": settings.client_id, "HISTORY_BACKEND": "postgres"}.items():
        monkeypatch.setenv(name, value)
    yield state
    verifier_for.cache_clear()
