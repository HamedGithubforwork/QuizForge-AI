"""One-shot read-only deep diagnostic for the permanent Lightsail repair plan."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
import sys
from typing import Any, Mapping

from .repair_review import (
    DEFAULT_TAGS,
    FINAL,
    EXISTING,
    REPAIR_CREATES,
    REPOSITORY,
    check_catalog_and_external_budget,
    review_plan,
)
from .review import (
    PROVIDER_NAME,
    REGION,
    Refused,
    Settings,
    check_source,
)

WORKFLOW = ".github/workflows/lightsail-repair-deep-diagnostic.yml"


def require(condition: bool, code: str) -> None:
    if not condition:
        raise Refused(code)


def trusted_invocation(env: Mapping[str, str]) -> None:
    require(env.get("GITHUB_EVENT_NAME") in {"push", "workflow_dispatch"}, "UNTRUSTED_INVOCATION")
    require(env.get("GITHUB_REF") == "refs/heads/main", "UNTRUSTED_INVOCATION")
    require(env.get("GITHUB_REPOSITORY") == REPOSITORY, "UNTRUSTED_INVOCATION")
    require(
        env.get("GITHUB_WORKFLOW_REF") == f"{REPOSITORY}/{WORKFLOW}@refs/heads/main",
        "UNTRUSTED_INVOCATION",
    )
    sha = env.get("GITHUB_SHA", "")
    require(bool(re.fullmatch(r"[0-9a-f]{40}", sha)), "UNTRUSTED_WORKFLOW_REVISION")
    require(env.get("GITHUB_WORKFLOW_SHA") == sha, "UNTRUSTED_WORKFLOW_REVISION")
    require(env.get("TF_WORKSPACE", "default") == "default", "NONDEFAULT_WORKSPACE")
    require(not env.get("ACTIONS_STEP_DEBUG") and not env.get("RUNNER_DEBUG"), "DEBUG_MODE_REFUSED")


def _shape(value: Any) -> dict[str, Any]:
    if value is None:
        return {"kind": "null"}
    if isinstance(value, list):
        return {"kind": "empty_list" if not value else "nonempty_list", "count": len(value)}
    if isinstance(value, dict):
        return {"kind": "empty_map" if not value else "nonempty_map", "count": len(value)}
    if isinstance(value, str):
        return {"kind": "empty_string" if value == "" else "nonempty_string", "length": len(value)}
    if isinstance(value, bool):
        return {"kind": "bool"}
    if isinstance(value, (int, float)):
        return {"kind": "number"}
    return {"kind": "other"}


def _tag_shape(value: Any) -> dict[str, Any]:
    if value is None:
        return {"kind": "null", "entry_count": 0}
    if not isinstance(value, dict):
        return {"kind": "non_map"}
    keys = set(value)
    approved = set(DEFAULT_TAGS)
    if not value:
        kind = "empty_map"
    elif value == DEFAULT_TAGS:
        kind = "exact_default_tags"
    elif keys == approved:
        kind = "default_tag_keys_wrong_values"
    elif keys <= approved:
        kind = "default_tag_key_subset"
    elif approved < keys:
        kind = "default_tags_plus_unexpected_keys"
    else:
        kind = "unexpected_tag_keys"
    return {
        "kind": kind,
        "entry_count": len(value),
        "approved_key_count": len(keys & approved),
        "unexpected_key_count": len(keys - approved),
    }


def _changed_fields(change: Mapping[str, Any]) -> list[str]:
    before = change.get("before")
    after = change.get("after")
    if not isinstance(before, Mapping) or not isinstance(after, Mapping):
        return []
    return sorted(
        key for key in set(before) | set(after)
        if isinstance(key, str)
        and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", key)
        and before.get(key) != after.get(key)
    )


def _resource_change_map(plan: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    result: dict[str, Mapping[str, Any]] = {}
    for item in plan.get("resource_changes", []) or []:
        if isinstance(item, Mapping) and isinstance(item.get("address"), str):
            result[str(item["address"])] = item
    return result


def _role_inline_policy_check(
    value: Any,
    separate_policy: Any,
) -> dict[str, Any]:
    result = _shape(value)
    result["matches_separate_policy"] = False
    result["all_entries_have_name"] = False
    if not isinstance(value, list) or not value:
        return result
    entries = [item for item in value if isinstance(item, Mapping)]
    result["structured_entry_count"] = len(entries)
    result["all_entries_have_name"] = (
        len(entries) == len(value)
        and all(isinstance(item.get("name"), str) and bool(item.get("name")) for item in entries)
    )
    policies = [item.get("policy") for item in entries]
    result["matches_separate_policy"] = (
        len(policies) == 1
        and isinstance(separate_policy, str)
        and policies[0] == separate_policy
    )
    return result


def analyze(plan: Mapping[str, Any], settings: Settings, catalog: Mapping[str, Any]) -> dict[str, Any]:
    changes = _resource_change_map(plan)
    drift = plan.get("resource_drift")
    drift_items = drift if isinstance(drift, list) else []
    deferred = plan.get("deferred_changes")
    invocations = plan.get("action_invocations")

    action_counts = {
        "create": 0,
        "noop": 0,
        "update": 0,
        "delete": 0,
        "replace": 0,
        "other": 0,
    }
    for item in changes.values():
        change = item.get("change")
        actions = change.get("actions") if isinstance(change, Mapping) else None
        if actions == ["create"]:
            action_counts["create"] += 1
        elif actions == ["no-op"]:
            action_counts["noop"] += 1
        elif actions == ["update"]:
            action_counts["update"] += 1
        elif actions == ["delete"]:
            action_counts["delete"] += 1
        elif actions == ["delete", "create"]:
            action_counts["replace"] += 1
        else:
            action_counts["other"] += 1

    separate_role_policy = None
    role_policy_item = changes.get("aws_iam_role_policy.recovery")
    if isinstance(role_policy_item, Mapping):
        role_policy_change = role_policy_item.get("change")
        if isinstance(role_policy_change, Mapping):
            role_policy_after = role_policy_change.get("after")
            if isinstance(role_policy_after, Mapping):
                separate_role_policy = role_policy_after.get("policy")

    expected_domain_prefix = f"quizforge-{settings.account}"
    expected_domain_host = f"{expected_domain_prefix}.auth.{REGION}.amazoncognito.com"

    resources: dict[str, Any] = {}
    unexpected_resource_count = 0
    for item in drift_items:
        if not isinstance(item, Mapping) or item.get("address") not in FINAL:
            unexpected_resource_count += 1
            continue
        address = str(item["address"])
        change = item.get("change")
        if not isinstance(change, Mapping):
            resources[address] = {"invalid_change_shape": True}
            continue

        before = change.get("before")
        after = change.get("after")
        before_map = before if isinstance(before, Mapping) else {}
        after_map = after if isinstance(after, Mapping) else {}
        fields = _changed_fields(change)

        entry: dict[str, Any] = {
            "mode_is_managed": item.get("mode") == "managed",
            "provider_matches": item.get("provider_name") == PROVIDER_NAME,
            "actions": change.get("actions") if isinstance(change.get("actions"), list) else [],
            "has_replace_paths": bool(change.get("replace_paths")),
            "has_importing": bool(change.get("importing")),
            "changed_attributes": fields,
        }

        if "tags" in fields:
            entry["tags"] = {
                "before": _tag_shape(before_map.get("tags")),
                "after": _tag_shape(after_map.get("tags")),
            }
        if "insufficient_data_actions" in fields:
            entry["insufficient_data_actions"] = {
                "before": _shape(before_map.get("insufficient_data_actions")),
                "after": _shape(after_map.get("insufficient_data_actions")),
            }
        if "layers" in fields:
            entry["layers"] = {
                "before": _shape(before_map.get("layers")),
                "after": _shape(after_map.get("layers")),
            }
        if "inline_policy" in fields:
            entry["inline_policy"] = {
                "before": _role_inline_policy_check(before_map.get("inline_policy"), separate_role_policy),
                "after": _role_inline_policy_check(after_map.get("inline_policy"), separate_role_policy),
            }
        if "domain" in fields:
            before_domain = before_map.get("domain")
            after_domain = after_map.get("domain")
            entry["domain"] = {
                "before": _shape(before_domain),
                "after": _shape(after_domain),
                "before_matches_expected_prefix": before_domain == expected_domain_prefix,
                "after_matches_expected_prefix": after_domain == expected_domain_prefix,
                "before_matches_expected_host": before_domain == expected_domain_host,
                "after_matches_expected_host": after_domain == expected_domain_host,
            }

        resources[address] = entry

    stripped_review_code = "PASS"
    try:
        stripped = copy.deepcopy(plan)
        stripped["resource_drift"] = []
        review_plan(stripped, settings, dict(catalog))
    except Refused as error:
        text = str(error)
        stripped_review_code = (
            text if re.fullmatch(r"[A-Z0-9_]{1,80}", text) else "REVIEW_REFUSED"
        )
    except Exception:
        stripped_review_code = "PRIVATE_REVIEW_FAILED"

    prior = (
        plan.get("prior_state", {})
        .get("values", {})
        .get("root_module", {})
        if isinstance(plan.get("prior_state"), Mapping)
        else {}
    )
    prior_resources = prior.get("resources", []) if isinstance(prior, Mapping) else []
    prior_managed_count = sum(
        1 for item in prior_resources
        if isinstance(item, Mapping) and item.get("mode") == "managed"
    )

    return {
        "schema": 1,
        "operation": "lightsail_repair_deep_diagnostic",
        "result": "diagnostic_completed_no_apply",
        "apply_attempted": False,
        "terraform_apply_completed": False,
        "catalog_bundle_available": catalog.get("lightsail_bundle_available") is True,
        "catalog_blueprint_available": catalog.get("lightsail_blueprint_available") is True,
        "external_budget_verified": catalog.get("external_budget_verified") is True,
        "prior_managed_resource_count": prior_managed_count,
        "expected_existing_resource_count": len(EXISTING),
        "expected_repair_create_count": len(REPAIR_CREATES),
        "plan_managed_resource_count": len(changes),
        "plan_action_counts": action_counts,
        "resource_drift_count": len(drift_items),
        "unexpected_resource_drift_count": unexpected_resource_count,
        "deferred_change_count": len(deferred) if isinstance(deferred, list) else 0,
        "action_invocation_count": len(invocations) if isinstance(invocations, list) else 0,
        "rest_of_plan_contract_after_ignoring_refresh_drift": stripped_review_code,
        "drift_resources": resources,
    }


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    root = Path.cwd()
    output = root / "lightsail-deep-diagnostic" / "summary.json"
    try:
        require(len(sys.argv) == 2, "UNEXPECTED_ARGUMENTS")
        env = dict(os.environ)
        trusted_invocation(env)
        settings = Settings.from_env(env)
        check_source(root)
        catalog = check_catalog_and_external_budget(settings)
        plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        report = analyze(plan, settings, catalog)
        write_json(output, report)
        print("Lightsail repair deep diagnostic completed; no apply was attempted.")
        return 0
    except Refused as error:
        code = str(error) if re.fullmatch(r"[A-Z0-9_]{1,80}", str(error)) else "DIAGNOSTIC_REFUSED"
    except Exception:
        code = "PRIVATE_DIAGNOSTIC_FAILED"

    write_json(output, {
        "schema": 1,
        "operation": "lightsail_repair_deep_diagnostic",
        "result": "diagnostic_blocked_no_apply",
        "apply_attempted": False,
        "terraform_apply_completed": False,
        "error_code": code,
    })
    print("Lightsail repair deep diagnostic refused.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
