"""Backend-first Google rollout evidence and rollback boundaries. No AWS mutations."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys

from scripts.production.lightsail.google_plan_guard import (
    IDENTITY_PROVIDER, BROWSER_CLIENT, safe_scope_change_summary,
)

APPLICATION = "77a060cce504008a4479deacdc31279633d0fe4f"
WORKFLOW = ".github/workflows/lightsail-release-promote.yml"


def verify_preflight(metadata, report, lock, now=None):
    now = now or datetime.now(timezone.utc)
    updated = datetime.fromisoformat(metadata["updated_at"].replace("Z", "+00:00"))
    age = (now - updated).total_seconds()
    if (metadata.get("event") != "workflow_dispatch"
            or metadata.get("path") != WORKFLOW or metadata.get("head_branch") != "main"
            or metadata.get("status") != "completed" or metadata.get("conclusion") != "success"
            or metadata.get("repository", {}).get("full_name") != "HamedGithubforwork/QuizForge-AI"
            or not -120 <= age <= 900):
        raise ValueError("Untrusted or stale backend inspection")
    if (lock.get("application_candidate_sha") != APPLICATION
            or not re.fullmatch(r"[0-9a-f]{40}", lock.get("release_sha", ""))
            or lock.get("ai_enabled") is not False):
        raise ValueError("Unexpected reviewed backend release")
    expected = {
        "inspection_only": True, "preflight_verified": True,
        "observed_current_release_sha": lock["release_sha"], "release_sha": lock["release_sha"],
        "release_switched": False, "frontend_switched": False,
        "baseline_firewall_restored": True, "temporary_ssh_rule_closed": True,
        "result": "production_promotion_preflight_verified",
    }
    if any(report.get(key) != value for key, value in expected.items()):
        raise ValueError("Reviewed backend is not verified live")
    return {"backend_release_verified": True, "release_sha": lock["release_sha"]}


def authorize_rollback(document, expected_pool):
    """Permit only removing Google from the same pool/client after a failed apply."""
    if document.get("format_version") not in {"1.0", "1.1", "1.2"} or document.get("resource_drift"):
        raise ValueError("Unexpected rollback plan")
    changes = document.get("resource_changes")
    if not isinstance(changes, list):
        raise ValueError("Missing rollback changes")
    seen = set()
    for resource in changes:
        change = resource.get("change") or {}
        if change.get("actions") == ["no-op"]:
            continue
        address = resource.get("address")
        if address in seen or address not in {IDENTITY_PROVIDER, BROWSER_CLIENT}:
            raise ValueError("Unrelated rollback change")
        seen.add(address)
        before, after = change.get("before"), change.get("after")
        if not isinstance(before, dict) or before.get("user_pool_id") != expected_pool:
            raise ValueError("Wrong rollback pool")
        if address == IDENTITY_PROVIDER:
            if (change.get("actions") != ["delete"] or after is not None
                    or before.get("provider_name") != "Google" or before.get("provider_type") != "Google"):
                raise ValueError("Rollback must remove only Google")
        else:
            if (change.get("actions") != ["update"] or not isinstance(after, dict)
                    or set(before.get("supported_identity_providers") or []) != {"COGNITO", "Google"}
                    or after.get("supported_identity_providers") != ["COGNITO"]
                    or {k: v for k, v in before.items() if k != "supported_identity_providers"}
                    != {k: v for k, v in after.items() if k != "supported_identity_providers"}):
                raise ValueError("Rollback changes existing browser settings")
    return {"rollback_scope_verified": True, "changes": safe_scope_change_summary(document)}


def main():
    try:
        if sys.argv[1] == "preflight":
            metadata, report, lock = [json.loads(Path(p).read_text()) for p in sys.argv[2:5]]
            result = verify_preflight(metadata, report, lock)
        elif sys.argv[1] == "scope":
            import boto3
            from scripts.production.lightsail.google_provider_readiness import exact_one, POOL_NAME
            pool = exact_one(boto3.client("cognito-idp", region_name="ca-central-1"),
                             "list_user_pools", "UserPools", POOL_NAME, MaxResults=60)["Id"]
            if not re.fullmatch(r"ca-central-1_[A-Za-z0-9]{1,55}", pool):
                raise ValueError("Unexpected production pool")
            arn = "arn:aws:cognito-idp:ca-central-1:399311815467:userpool/" + pool
            print("::add-mask::" + pool)
            print("::add-mask::" + arn)
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write("pool_id=" + pool + "\npool_arn=" + arn + "\n")
            result = {"existing_pool_scope_verified": True}
        elif sys.argv[1] == "rollback":
            result = authorize_rollback(json.loads(Path(sys.argv[2]).read_text()),
                                        os.environ["PRODUCTION_POOL_ID"])
        else:
            raise ValueError("Unsupported operation")
    except Exception:
        raise SystemExit("FAIL: protected Google rollout prerequisite or rollback scope not verified") from None
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
