"""Opt-in Cognito access-token verification. No AWS credentials or email linking.

Only keys from the configured Canadian user pool are trusted. JWT verification
is followed by GetUser on every request: cached signing keys are not a cached
authorization decision, and revoked sessions must not remain usable here.
"""
import asyncio
from dataclasses import dataclass
from functools import lru_cache
import json
import os
import re
import time
from uuid import UUID

from fastapi import HTTPException
import httpx
import jwt


USER_SCOPE = "aws.cognito.signin.user.admin"
MAX_TOKEN_BYTES = 16_384
MAX_RESPONSE_BYTES = 65_536
KEY_TTL_SECONDS = 300
REFRESH_COOLDOWN_SECONDS = 30


def invalid_session():
    return HTTPException(401, "Your session is invalid or has expired.")


def unavailable():
    return HTTPException(503, "Authentication service is temporarily unavailable.")


def auth_provider():
    provider = os.getenv("AUTH_PROVIDER", "supabase").strip().lower()
    if provider not in ("supabase", "cognito"):
        raise RuntimeError("AUTH_PROVIDER must be supabase or cognito")
    return provider


@dataclass(frozen=True)
class CognitoSettings:
    pool_id: str
    client_id: str

    def __post_init__(self):
        if (not re.fullmatch(r"ca-central-1_[A-Za-z0-9]{1,55}", self.pool_id)
                or not re.fullmatch(r"[a-z0-9]{1,128}", self.client_id)):
            raise RuntimeError("Cognito requires a ca-central-1 pool and app client")

    @property
    def endpoint(self):
        return "https://cognito-idp.ca-central-1.amazonaws.com/"

    @property
    def issuer(self):
        return self.endpoint + self.pool_id

    @classmethod
    def from_environment(cls):
        return cls(os.getenv("COGNITO_USER_POOL_ID", ""), os.getenv("COGNITO_CLIENT_ID", ""))


def validate_auth_configuration():
    if auth_provider() == "cognito":
        CognitoSettings.from_environment()
        # A Cognito JWT cannot authorize Supabase PostgREST. Never forward it there.
        if os.getenv("HISTORY_BACKEND", "supabase").strip().lower() != "postgres":
            raise RuntimeError("Cognito authentication requires PostgreSQL history")


async def bounded_json(client, method, url, **kwargs):
    try:
        async with client.stream(method, url, follow_redirects=False, timeout=8, **kwargs) as response:
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise unavailable()
            try:
                data = json.loads(body)
            except (ValueError, UnicodeError):
                raise unavailable() from None
            if not isinstance(data, dict):
                raise unavailable()
            return response.status_code, data
    except httpx.RequestError:
        raise unavailable() from None


class CognitoVerifier:
    def __init__(self, settings):
        self.settings = settings
        self.keys = {}
        self.expires_at = 0.0
        self.last_refresh = float("-inf")
        self.lock = asyncio.Lock()

    async def signing_key(self, client, kid):
        now = time.monotonic()
        if now < self.expires_at and kid in self.keys:
            return self.keys[kid]
        async with self.lock:
            now = time.monotonic()
            if now < self.expires_at and kid in self.keys:
                return self.keys[kid]
            # Unknown key IDs cannot amplify arbitrary requests to AWS. Rotation
            # can cause a bounded 30-second retry window; never accept an unknown key.
            if now - self.last_refresh < REFRESH_COOLDOWN_SECONDS:
                if now >= self.expires_at:
                    raise unavailable()
                raise invalid_session()
            self.last_refresh = now
            status, data = await bounded_json(client, "GET", self.settings.issuer + "/.well-known/jwks.json")
            if status != 200 or not isinstance(data.get("keys"), list) or not 1 <= len(data["keys"]) <= 8:
                raise unavailable()
            keys = {}
            try:
                for raw in data["keys"]:
                    if (not isinstance(raw, dict) or raw.get("kty") != "RSA"
                            or raw.get("alg") != "RS256" or raw.get("use") != "sig"
                            or not isinstance(raw.get("kid"), str) or not 1 <= len(raw["kid"]) <= 256
                            or raw["kid"] in keys):
                        raise ValueError
                    key = jwt.PyJWK.from_dict(raw, algorithm="RS256").key
                    if not 2048 <= key.key_size <= 4096:
                        raise ValueError
                    keys[raw["kid"]] = key
            except (ValueError, TypeError, jwt.PyJWTError):
                raise unavailable() from None
            self.keys = keys
            self.expires_at = time.monotonic() + KEY_TTL_SECONDS
            if kid not in keys:
                raise invalid_session()
            return keys[kid]

    async def verify(self, token, client):
        if not token or len(token) > MAX_TOKEN_BYTES:
            raise invalid_session()
        try:
            header = jwt.get_unverified_header(token)
            if (header.get("alg") != "RS256" or not isinstance(header.get("kid"), str)
                    or not 1 <= len(header["kid"]) <= 256
                    or any(name in header for name in ("jku", "jwk", "x5u", "crit"))):
                raise invalid_session()
        except jwt.PyJWTError:
            raise invalid_session() from None
        key = await self.signing_key(client, header["kid"])
        try:
            claims = jwt.decode(token, key, algorithms=["RS256"], issuer=self.settings.issuer,
                                options={"require": ["exp", "iat", "auth_time", "sub", "iss",
                                                     "client_id", "token_use", "scope"],
                                         "verify_aud": False})
            if (claims["token_use"] != "access" or claims["client_id"] != self.settings.client_id
                    or "aud" in claims  # Resource-bound tokens need an explicit future audience policy.
                    or not isinstance(claims["scope"], str)
                    or USER_SCOPE not in claims["scope"].split()
                    or any(type(claims[name]) is not int for name in ("exp", "iat", "auth_time"))
                    or not 0 < claims["auth_time"] <= claims["iat"] < claims["exp"]
                    or claims["exp"] - claims["iat"] > 3600
                    or not isinstance(claims["sub"], str)
                    or str(UUID(claims["sub"])) != claims["sub"]):
                raise invalid_session()
        except (jwt.PyJWTError, ValueError, TypeError):
            raise invalid_session() from None

        status, user = await bounded_json(client, "POST", self.settings.endpoint,
                                         headers={"Content-Type": "application/x-amz-json-1.1",
                                                  "X-Amz-Target": "AWSCognitoIdentityProviderService.GetUser"},
                                         json={"AccessToken": token})
        if status != 200:
            error = user.get("__type", "")
            error = error.rsplit("#", 1)[-1] if isinstance(error, str) else ""
            if status in (400, 401, 403) and error in {
                    "NotAuthorizedException", "UserNotFoundException", "UserNotConfirmedException",
                    "PasswordResetRequiredException", "ForbiddenException"}:
                raise invalid_session()
            raise unavailable()
        attributes = user.get("UserAttributes")
        if not isinstance(attributes, list):
            raise unavailable()
        values = {}
        for attribute in attributes:
            if (not isinstance(attribute, dict) or not isinstance(attribute.get("Name"), str)
                    or not isinstance(attribute.get("Value"), str) or attribute["Name"] in values):
                raise unavailable()
            values[attribute["Name"]] = attribute["Value"]
        if values.get("sub") != claims["sub"]:
            raise invalid_session()
        # Email verification is a signup protection, never an ownership lookup.
        if values.get("email_verified") != "true" or not values.get("email"):
            raise HTTPException(403, "A verified email address is required.")
        return claims["sub"], values["email"]


@lru_cache(maxsize=1)
def verifier_for(settings):
    return CognitoVerifier(settings)
