"""Prepare only public application configuration for the permanent Lightsail release.

Reads the already-created Cognito resources and combines them with the public
legacy Supabase client configuration. No secrets are read and no cloud changes
are made.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import sys
from typing import Any

try:
    import boto3
except ModuleNotFoundError:
    boto3 = None

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build import public_config

REGION = "ca-central-1"
POOL_NAME = "quizforge-production-lightsail"
CLIENT_NAME = "quizforge-production-pkce"
LEGACY_URL = "https://vfxmsvphgcaizqnbyjip.supabase.co"


def _pages(client, method: str, result_key: str, **kwargs) -> list[dict[str, Any]]:
    token = None
    result: list[dict[str, Any]] = []
    while True:
        request = dict(kwargs)
        if token:
            request["NextToken"] = token
        response = getattr(client, method)(**request)
        values = response.get(result_key) or []
        if not isinstance(values, list):
            raise ValueError("Unexpected AWS list response")
        result.extend(item for item in values if isinstance(item, dict))
        token = response.get("NextToken")
        if not token:
            return result


def read_public_source(path: Path) -> dict[str, str]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if set(value) != {"legacy_url", "legacy_publishable_key"}:
        raise ValueError("Unexpected public source fields")
    if value["legacy_url"] != LEGACY_URL:
        raise ValueError("Unexpected legacy project URL")
    key = value["legacy_publishable_key"]
    if not isinstance(key, str) or not re.fullmatch(
        r"sb_publishable_[A-Za-z0-9_-]{20,}", key
    ):
        raise ValueError("Expected a Supabase publishable client key")
    return value


def discover_public_config(source: dict[str, str], sts, cognito) -> dict[str, str]:
    account = sts.get_caller_identity().get("Account")
    if not isinstance(account, str) or not re.fullmatch(r"[0-9]{12}", account):
        raise ValueError("Unexpected AWS account identity")

    pools = [
        item
        for item in _pages(
            cognito,
            "list_user_pools",
            "UserPools",
            MaxResults=60,
        )
        if item.get("Name") == POOL_NAME
    ]
    if len(pools) != 1 or not isinstance(pools[0].get("Id"), str):
        raise ValueError("Expected exactly one production Cognito pool")
    pool_id = pools[0]["Id"]

    clients = [
        item
        for item in _pages(
            cognito,
            "list_user_pool_clients",
            "UserPoolClients",
            UserPoolId=pool_id,
            MaxResults=60,
        )
        if item.get("ClientName") == CLIENT_NAME
    ]
    if len(clients) != 1 or not isinstance(clients[0].get("ClientId"), str):
        raise ValueError("Expected exactly one production Cognito browser client")
    client_id = clients[0]["ClientId"]

    domain = f"quizforge-{account}"
    description = cognito.describe_user_pool_domain(Domain=domain).get(
        "DomainDescription", {}
    )
    if description.get("UserPoolId") != pool_id:
        raise ValueError("Production Cognito domain is not attached to expected pool")

    config = {
        "pool": pool_id,
        "client": client_id,
        "auth_origin": f"https://{domain}.auth.{REGION}.amazoncognito.com",
        "frontend_url": "https://quizfromnotes.com",
        "api_url": "https://api.quizfromnotes.com",
        "legacy_url": source["legacy_url"],
        "legacy_publishable_key": source["legacy_publishable_key"],
    }
    return public_config(config)


def write_private_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o600)


def safe_public_summary(config: dict[str, str]) -> dict[str, Any]:
    return {
        "schema": 1,
        "cognito_pool_configured": bool(config.get("pool")),
        "cognito_client_configured": bool(config.get("client")),
        "cognito_auth_origin_expected": bool(
            re.fullmatch(
                r"https://quizforge-[0-9]{12}\.auth\.ca-central-1\.amazoncognito\.com",
                config.get("auth_origin", ""),
            )
        ),
        "frontend_url_expected": config.get("frontend_url") == "https://quizfromnotes.com",
        "api_url_expected": config.get("api_url") == "https://api.quizfromnotes.com",
        "legacy_project_expected": config.get("legacy_url") == LEGACY_URL,
        "legacy_key_is_publishable": bool(
            re.fullmatch(
                r"sb_publishable_[A-Za-z0-9_-]{20,}",
                config.get("legacy_publishable_key", ""),
            )
        ),
    }


def main() -> int:
    if len(sys.argv) != 4 or sys.argv[1] != "public-config":
        print("Usage: release_candidate.py public-config SOURCE OUTPUT", file=sys.stderr)
        return 2
    if boto3 is None:
        print("AWS SDK missing", file=sys.stderr)
        return 1
    try:
        source = read_public_source(Path(sys.argv[2]))
        sts = boto3.client("sts", region_name=REGION)
        cognito = boto3.client("cognito-idp", region_name=REGION)
        config = discover_public_config(source, sts, cognito)
        write_private_json(Path(sys.argv[3]), config)
        print(json.dumps(safe_public_summary(config), sort_keys=True))
        return 0
    except Exception as error:
        print(
            json.dumps(
                {
                    "result": "public_config_failed",
                    "error_type": type(error).__name__,
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
