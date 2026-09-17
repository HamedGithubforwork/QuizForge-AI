"""Online, recent proof of the two accounts. Emails never identify an owner."""
from dataclasses import dataclass
import time
from uuid import UUID

from fastapi import HTTPException
import jwt

from cognito_auth import bounded_json, invalid_session, unavailable


@dataclass(frozen=True)
class Identity:
    issuer: str
    subject: str


async def supabase_link_proof(token, client, url, publishable_key):
    if not token or len(token) > 16_384:
        raise invalid_session()
    # GetUser cryptographically authenticates this exact token at the trusted
    # configured issuer BEFORE its AMR claims are examined locally.
    status, user = await bounded_json(client, "GET", url + "/auth/v1/user", headers={
        "Authorization": "Bearer " + token, "apikey": publishable_key})
    if status in (401, 403):
        raise invalid_session()
    if status != 200:
        raise unavailable()
    try:
        claims = jwt.decode(token, options={"verify_signature": False})
        now = time.time()
        subject = str(UUID(user["id"]))
        if (claims.get("iss") != url + "/auth/v1" or claims.get("sub") != subject
                or claims.get("aud") != "authenticated" or claims.get("role") != "authenticated"
                or claims.get("is_anonymous") is not False
                or not user.get("email_confirmed_at") or user.get("is_anonymous") is True
                or type(claims.get("exp")) is not int or claims["exp"] <= now
                or type(claims.get("iat")) is not int or claims["iat"] > now
                or not isinstance(claims.get("amr"), list)):
            raise ValueError
        str(UUID(claims["session_id"]))
        recent = {item["method"] for item in claims["amr"] if isinstance(item, dict)
                  and isinstance(item.get("method"), str) and type(item.get("timestamp")) is int
                  and 0 <= now - item["timestamp"] <= 300}
        if "password" not in recent:
            raise ValueError
        factors = user.get("factors", [])
        if not isinstance(factors, list):
            raise ValueError
        if any(f.get("status") == "verified" for f in factors):
            if claims.get("aal") != "aal2" or "totp" not in recent:
                raise ValueError
    except (jwt.PyJWTError, KeyError, ValueError, TypeError, AttributeError):
        raise HTTPException(401, "Sign in again to your existing account, including MFA if enabled.") from None
    return Identity(url + "/auth/v1", subject)
