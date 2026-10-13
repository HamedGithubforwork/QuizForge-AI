"""Fail-closed inspection of a production Google-only Terraform plan.

This checks local Terraform JSON only. Never logs planned values or credentials,
and never touches AWS. Exit code 2 from terraform plan is expected when the
exactly two authorized resources differ from the existing production state.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import sys

IDENTITY_PROVIDER = "aws_cognito_identity_provider.google[0]"
BROWSER_CLIENT = "aws_cognito_user_pool_client.browser"
USER_POOL = "aws_cognito_user_pool.browser"
ALLOWED = {
    IDENTITY_PROVIDER: ["create"],
    BROWSER_CLIENT: ["update"],
}


def authorize(document: dict, expected_google_client_id: str) -> dict:
    if document.get("format_version") not in ("1.0", "1.1", "1.2"):
        raise ValueError("Unexpected Terraform plan format")
    changes = document.get("resource_changes")
    if not isinstance(changes, list):
        raise ValueError("No Terraform resource change details")
    present = {}
    for resource in changes:
        if not isinstance(resource, dict) or not isinstance(resource.get("address"), str):
            raise ValueError("Malformed Terraform change")
        address = resource["address"]
        change = resource.get("change") or {}
        actions = change.get("actions")
        if actions == ["no-op"]:
            continue
        if address not in ALLOWED or actions != ALLOWED[address] or address in present:
            raise ValueError("Plan has a non-Google or destructive production change")
        before, after = change.get("before"), change.get("after")
        if not isinstance(after, dict):
            raise ValueError("Expected one directly scoped Cognito change")
        if address == IDENTITY_PROVIDER:
            if before is not None or after.get("provider_name") != "Google":
                raise ValueError("Google provider must be new and separate")
            if after.get("provider_type") != "Google":
                raise ValueError("Unexpected Google provider type")
            details = after.get("provider_details") or {}
            if (details.get("client_id") != expected_google_client_id
                    or details.get("authorize_scopes") != "openid email"
                    or not isinstance(details.get("client_secret"), str)
                    or len(details["client_secret"]) < 10):
                raise ValueError("Google OAuth settings mismatch")
            mapping = after.get("attribute_mapping") or {}
            if mapping.get("email") != "email" or mapping.get("email_verified") != "email_verified":
                raise ValueError("Google claim mapping mismatch")
        else:
            if not isinstance(before, dict):
                raise ValueError("Missing current browser app-client state")
            old = before.get("supported_identity_providers")
            new = after.get("supported_identity_providers")
            if set(old or []) != {"COGNITO"} or set(new or []) != {"COGNITO", "Google"}:
                raise ValueError("Must preserve existing password sign-in")
            for key in ("client_id", "name", "user_pool_id", "callback_urls", "logout_urls",
                        "allowed_oauth_flows", "allowed_oauth_scopes", "explicit_auth_flows",
                        "refresh_token_validity", "access_token_validity", "id_token_validity"):
                if before.get(key) != after.get(key):
                    raise ValueError("Unreviewed app-client configuration change")
        present[address] = actions[0]

    if present != {IDENTITY_PROVIDER: "create", BROWSER_CLIENT: "update"}:
        raise ValueError("Expected precisely one provider creation and one app-client update")
    if document.get("resource_drift"):
        raise ValueError("Unexpected Terraform drift during read-only review")
    return {"approved": True, "resources": [
        {"address": IDENTITY_PROVIDER, "action": "create"},
        {"address": BROWSER_CLIENT, "action": "update"},
    ], "production_changes_applied": False}


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m scripts.production.lightsail.google_plan_guard <tfplan.json>")
    try:
        expected_id = os.environ["PROD_GOOGLE_OAUTH_CLIENT_ID"]
        document = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        report = authorize(document, expected_id)
    except Exception:
        raise SystemExit("FAIL: Google-only Terraform scope not verified; NO APPLY made") from None
    # Output contains only the stable, nonsecret resource names and action types.
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
