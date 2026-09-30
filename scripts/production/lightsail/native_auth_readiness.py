"""Read-only desktop Cognito readiness; never creates clients or changes IAM/auth."""
from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import tempfile

import boto3

from scripts.production.lightsail.style_cognito_hosted_ui import (
    CLIENT_NAME, CLIENT_RE, POOL_NAME, REGION, discover, pages,
)

SOURCE = Path("scripts/production/lightsail/native-client-source.json")
CHECKOUT = Path("application-configuration")
RESULT = Path("native-auth-readiness-results/summary.json")


def source_commit():
    value = json.loads(SOURCE.read_text())
    if set(value) != {"application_commit"} or not re.fullmatch(r"[a-f0-9]{40}", value["application_commit"]):
        raise ValueError("Invalid native configuration source pin")
    return value["application_commit"]


def policy_command(*args):
    command = ["node", str(CHECKOUT / "desktop/scripts/native-client-config.cjs"), *args]
    result = subprocess.run(command, capture_output=True, text=True, timeout=15, check=False)
    if result.returncode or len(result.stdout.encode()) > 65536:
        raise ValueError("Native client policy check failed")
    return result.stdout


def expected_policy(pool_id):
    return json.loads(policy_command("generate", pool_id))


def verify_policy(description, pool_id, web_client_id):
    raw = json.dumps(description, default=str)
    if len(raw.encode()) > 65536:
        raise ValueError("Native client description is oversized")
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "description.json"
        path.write_text(raw, encoding="utf-8")
        path.chmod(0o600)
        policy_command("verify", pool_id, web_client_id, str(path))


def inspect(sts, cognito, *, policy=expected_policy, verify=verify_policy):
    account = sts.get_caller_identity().get("Account", "")
    if not re.fullmatch(r"[0-9]{12}", account):
        raise ValueError("Unexpected AWS account response")
    pool_id, web_id = discover(cognito)
    pool = cognito.describe_user_pool(UserPoolId=pool_id)["UserPool"]
    if (pool.get("Id") != pool_id or pool.get("Name") != POOL_NAME
            or pool.get("UserPoolTier") != "LITE" or pool.get("DeletionProtection") != "ACTIVE"):
        raise ValueError("Expected the protected existing Lite pool")
    domain = cognito.describe_user_pool_domain(Domain=f"quizforge-{account}")["DomainDescription"]
    if (domain.get("UserPoolId") != pool_id or domain.get("AWSAccountId") != account
            or domain.get("Status") != "ACTIVE" or domain.get("ManagedLoginVersion") != 1):
        raise ValueError("Expected the existing active classic hosted domain")
    web = cognito.describe_user_pool_client(UserPoolId=pool_id, ClientId=web_id)["UserPoolClient"]
    if (web.get("UserPoolId") != pool_id or web.get("ClientId") != web_id or web.get("ClientName") != CLIENT_NAME
            or "ClientSecret" in web or web.get("AllowedOAuthFlows") != ["code"]
            or web.get("CallbackURLs") != ["https://quizfromnotes.com/auth/callback"]):
        raise ValueError("Existing web client boundary does not match")
    expected = policy(pool_id)
    clients = [item for item in pages(cognito, "list_user_pool_clients", "UserPoolClients", UserPoolId=pool_id, MaxResults=60)
               if item.get("ClientName") == expected["ClientName"]]
    if len(clients) > 1:
        raise ValueError("Ambiguous native clients; do not create another")
    if clients:
        native_id = clients[0].get("ClientId", "")
        if not CLIENT_RE.fullmatch(str(native_id)) or native_id == web_id:
            raise ValueError("Native client identity is invalid")
        description = cognito.describe_user_pool_client(UserPoolId=pool_id, ClientId=native_id)
        if description.get("UserPoolClient", {}).get("ClientId") != native_id:
            raise ValueError("Native description returned another client")
        verify(description, pool_id, web_id)
    return {
        "schema": 1,
        "result": "client_configuration_verified" if clients else "registration_required",
        "protected_lite_pool_verified": True,
        "classic_domain_verified": True,
        "web_client_boundary_verified": True,
        "native_client_present": bool(clients),
        "changes_performed": False,
        "login_acceptance_performed": False,
    }


def main():
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    try:
        commit = source_commit()
        actual = subprocess.run(["git", "-C", str(CHECKOUT), "rev-parse", "HEAD"],
                                capture_output=True, text=True, timeout=10, check=True).stdout.strip()
        if actual != commit:
            raise ValueError("Configuration checkout is not pinned")
        summary = inspect(boto3.client("sts", region_name=REGION), boto3.client("cognito-idp", region_name=REGION))
        summary["configuration_commit"] = commit
        RESULT.write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary))
        return 0
    except Exception:
        RESULT.write_text(json.dumps({"schema": 1, "result": "inspection_failed", "changes_performed": False}) + "\n")
        print("Native authentication readiness inspection failed; no settings changed. Private service details are not logged.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
