import asyncio
import time
from uuid import UUID

from fastapi import HTTPException
import httpx
import jwt
import pytest

from identity_proofs import supabase_link_proof
from identity_app import settings, public_legacy_key


def legacy_token(**changes):
    now = int(time.time())
    return jwt.encode({"iss": "https://legacy.test/auth/v1", "sub": str(UUID(int=1)), "aud": "authenticated",
                       "role": "authenticated", "is_anonymous": False, "exp": now + 300, "iat": now - 10,
                       "session_id": str(UUID(int=2)), "aal": "aal1",
                       "amr": [{"method": "password", "timestamp": now - 20}], **changes}, "test-only-key" * 3)


def proof(token, status=200, changes=None):
    async def run():
        user = {"id": str(UUID(int=1)), "email_confirmed_at": "2026-01-01", "factors": [], **(changes or {})}
        def remote(request):
            assert str(request.url) == "https://legacy.test/auth/v1/user"
            assert request.headers["Authorization"] == "Bearer " + token
            return httpx.Response(status, json=user)
        async with httpx.AsyncClient(transport=httpx.MockTransport(remote)) as client:
            return await supabase_link_proof(token, client, "https://legacy.test", "publishable")
    return asyncio.run(run())


def test_recent_online_verified_password_proof_and_mfa():
    assert proof(legacy_token()).subject == str(UUID(int=1))
    token = legacy_token(aal="aal2", amr=[{"method": method, "timestamp": int(time.time()) - 10}
                                        for method in ("password", "totp")])
    assert proof(token, changes={"factors": [{"status": "verified"}]}).subject == str(UUID(int=1))


@pytest.mark.parametrize("changes", [
    {"iss": "https://evil.test/auth/v1"}, {"sub": str(UUID(int=2))}, {"aud": "anon"},
    {"role": "service_role"}, {"is_anonymous": True}, {"exp": 1}, {"iat": 9999999999},
    {"session_id": "bad"}, {"amr": []}, {"amr": [{"method": "token_refresh", "timestamp": int(time.time())}]},
    {"amr": [{"method": "password", "timestamp": int(time.time()) - 600}]},
    {"amr": [{"method": "password", "timestamp": 9999999999}]},
    {"amr": [{"method": "password", "timestamp": True}]}, {"amr": "bad"},
])
def test_claims_cannot_substitute_for_recent_proof(changes):
    with pytest.raises(HTTPException) as error: proof(legacy_token(**changes))
    assert error.value.status_code == 401


@pytest.mark.parametrize("status,expected", [(401,401), (403,401), (429,503), (500,503)])
def test_online_failure_is_not_bypassed(status, expected):
    with pytest.raises(HTTPException) as error: proof(legacy_token(), status)
    assert error.value.status_code == expected


@pytest.mark.parametrize("changes", [{"email_confirmed_at": None}, {"is_anonymous": True},
                                      {"factors": [{"status": "verified"}]}, {"factors": "bad"}])
def test_email_and_enrolled_mfa_must_be_verified(changes):
    with pytest.raises(HTTPException) as error: proof(legacy_token(), changes=changes)
    assert error.value.status_code == 401


def test_identity_service_fails_closed_without_staging_and_exact_origin(monkeypatch):
    monkeypatch.delenv("IDENTITY_STAGING_ENABLED", raising=False)
    with pytest.raises(RuntimeError): settings()
    monkeypatch.setenv("IDENTITY_STAGING_ENABLED", "true")
    for origin in ("*", "http://public.test", "https://test/path", "https://test?x=y", "https://user@test"):
        monkeypatch.setenv("IDENTITY_ALLOWED_ORIGIN", origin)
        with pytest.raises(RuntimeError): settings()
    monkeypatch.setenv("IDENTITY_ALLOWED_ORIGIN", "https://staging.test")
    assert settings()[0] == "https://staging.test"


def test_production_enrollment_requires_exact_reviewed_configuration(monkeypatch):
    values = {"IDENTITY_ENVIRONMENT": "production", "IDENTITY_ALLOWED_ORIGIN": "https://quizfromnotes.com",
              "IDENTITY_DB_HOST": "quizforge-production.abcdef.ca-central-1.rds.amazonaws.com",
              "IDENTITY_DB_NAME": "quizforge", "IDENTITY_SUPABASE_URL": "https://vfxmsvphgcaizqnbyjip.supabase.co",
              "IDENTITY_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_synthetic_public_key_12345"}
    monkeypatch.delenv("IDENTITY_STAGING_ENABLED", raising=False)
    for name, value in values.items(): monkeypatch.setenv(name, value)
    assert settings()[0] == values["IDENTITY_ALLOWED_ORIGIN"]
    for name, bad in (("IDENTITY_ALLOWED_ORIGIN", "https://staging.test"), ("IDENTITY_DB_NAME", "quizforge_rehearsal"),
                      ("IDENTITY_DB_HOST", "foreign.ca-central-1.rds.amazonaws.com"),
                      ("IDENTITY_SUPABASE_URL", "https://foreign.supabase.co"),
                      ("IDENTITY_SUPABASE_PUBLISHABLE_KEY", ""), ("IDENTITY_ENVIRONMENT", "prod")):
        monkeypatch.setenv(name, bad)
        with pytest.raises(RuntimeError): settings()
        monkeypatch.setenv(name, values[name])
    monkeypatch.setenv("IDENTITY_STAGING_ENABLED", "true")
    with pytest.raises(RuntimeError): settings()


def test_production_configuration_rejects_privileged_legacy_keys():
    def token(role, ref="vfxmsvphgcaizqnbyjip"):
        return jwt.encode({"role":role,"ref":ref},"synthetic-config-only" * 3)
    assert public_legacy_key(token("anon"))
    for key in (token("service_role"),token("authenticated"),token("anon","foreign"),
                "sb_secret_synthetic_secret_key_12345","bad"):
        assert not public_legacy_key(key)


def test_lightsail_production_requires_explicit_target_role_port_and_ca(monkeypatch):
    values = {"IDENTITY_ENVIRONMENT": "production", "IDENTITY_ALLOWED_ORIGIN": "https://quizfromnotes.com",
              "IDENTITY_DB_HOST": "db.quizforge.internal", "IDENTITY_DB_NAME": "quizforge",
              "IDENTITY_DB_USER": "quizforge_identity", "IDENTITY_DB_PORT": "5432",
              "IDENTITY_DB_SSLROOTCERT": "/run/quizforge/db-ca.pem", "PRODUCTION_DATABASE_TARGET": "lightsail",
              "IDENTITY_SUPABASE_URL": "https://vfxmsvphgcaizqnbyjip.supabase.co",
              "IDENTITY_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_synthetic_public_key_12345"}
    monkeypatch.delenv("IDENTITY_STAGING_ENABLED", raising=False)
    for name, value in values.items(): monkeypatch.setenv(name, value)
    assert settings()[0] == values["IDENTITY_ALLOWED_ORIGIN"]
    for name, bad in (("PRODUCTION_DATABASE_TARGET", "rds"), ("PRODUCTION_DATABASE_TARGET", "unknown"),
                      ("IDENTITY_DB_HOST", "localhost"), ("IDENTITY_DB_HOST", "restore-db.quizforge.internal"),
                      ("IDENTITY_DB_USER", "quizforge_owner"), ("IDENTITY_DB_PORT", "5433"),
                      ("IDENTITY_DB_SSLROOTCERT", "")):
        monkeypatch.setenv(name, bad)
        with pytest.raises(RuntimeError): settings()
        monkeypatch.setenv(name, values[name])
