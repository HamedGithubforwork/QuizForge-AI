"""Read-only production Cognito Google OAuth preflight.

No provider/client mutations, Terraform state reads, or printing credentials.
Never print AWS provider details (they may contain Google client_secret).
"""
from __future__ import annotations

import os
import re

REGION = "ca-central-1"
ACCOUNT_ID = "399311815467"
POOL_NAME = "quizforge-production-lightsail"
CLIENT_NAME = "quizforge-production-pkce"
CALLBACK = "https://quizfromnotes.com/auth/callback"
LOGOUT = "https://quizfromnotes.com/"


def validate_google_credentials(client_id: str | None, secret: str | None) -> bool:
    return (
        isinstance(client_id, str)
        and bool(re.fullmatch(r"[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com", client_id))
        and isinstance(secret, str)
        and len(secret) >= 10
        and len(secret) <= 4096
        and not any(ch.isspace() for ch in secret)
    )


def exact_one(client, method: str, key: str, expected_name: str, **kwargs):
    """Fail closed on absent or duplicated resources; never print provider objects."""
    found = []
    token = None
    while True:
        params = dict(kwargs)
        if token is not None:
            params["NextToken"] = token
        page = getattr(client, method)(**params)
        found.extend(item for item in page.get(key, [])
                     if isinstance(item, dict) and item.get("Name" if key == "UserPools" else "ClientName") == expected_name)
        token = page.get("NextToken")
        if not token:
            break
    if len(found) != 1 or not isinstance(found[0].get("Id" if key == "UserPools" else "ClientId"), str):
        raise ValueError("Expected one existing production Cognito resource")
    return found[0]


def inspect_account(*, sts, cognito, client_id: str, secret: str):
    if not validate_google_credentials(client_id, secret):
        raise ValueError("Protected production Google credentials are missing or invalid")
    if sts.get_caller_identity().get("Account") != ACCOUNT_ID:
        raise ValueError("Expected production AWS account")

    pool = exact_one(cognito, "list_user_pools", "UserPools", POOL_NAME, MaxResults=60)
    pool_id = pool["Id"]
    if not pool_id.startswith(REGION + "_"):
        raise ValueError("Unexpected Cognito pool region")
    app = exact_one(cognito, "list_user_pool_clients", "UserPoolClients", CLIENT_NAME,
                    UserPoolId=pool_id, MaxResults=60)
    browser = cognito.describe_user_pool_client(UserPoolId=pool_id, ClientId=app["ClientId"]).get("UserPoolClient", {})
    providers = browser.get("SupportedIdentityProviders") or []
    if (set(providers) not in ({"COGNITO"}, {"COGNITO", "Google"})
        or browser.get("CallbackURLs") != [CALLBACK]
        or browser.get("LogoutURLs") != [LOGOUT]
        or browser.get("AllowedOAuthFlows") != ["code"]
        or browser.get("GenerateSecret") is True):
        raise ValueError("Unexpected production browser client or OAuth callback configuration")

    try:
        provider = cognito.describe_identity_provider(UserPoolId=pool_id, ProviderName="Google").get("IdentityProvider", {})
    except Exception as error:
        # Only a NotFound response is an acceptable missing provider; all other
        # AWS errors must fail without exposing service exception contents.
        if getattr(error, "response", {}).get("Error", {}).get("Code") not in (
            "ResourceNotFoundException", "ResourceNotFound"
        ):
            raise ValueError("Could not safely read Google provider status") from None
        provider = None
    if provider is None:
        if "Google" in providers:
            raise ValueError("Browser client lists a missing Google provider")
        return "not_connected_ready_for_review"
    if (provider.get("ProviderType") != "Google"
            or provider.get("ProviderDetails", {}).get("client_id") != client_id
            or provider.get("ProviderDetails", {}).get("authorize_scopes") != "openid email"):
        raise ValueError("Existing production Google provider differs from protected client")
    if "Google" not in providers:
        return "google_provider_exists_not_authorized_for_client"
    return "google_provider_and_client_configured"


def main():
    import boto3
    # Environment secrets are only read within the protected production job.
    client_id = os.environ.get("PROD_GOOGLE_OAUTH_CLIENT_ID")
    secret = os.environ.get("PROD_GOOGLE_OAUTH_CLIENT_SECRET")
    try:
        status = inspect_account(
            sts=boto3.client("sts", region_name=REGION),
            cognito=boto3.client("cognito-idp", region_name=REGION),
            client_id=client_id,
            secret=secret,
        )
    except Exception:
        # Don't print secret values or provider/AWS exception details.
        raise SystemExit("FAIL: read-only production Google readiness check; no changes made") from None
    print("PASS: production Google OAuth status: " + status)
    print("No AWS settings, OAuth credentials, account data, or production services changed.")


if __name__ == "__main__":
    main()
