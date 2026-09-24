"""Fail-closed review for repairing the partial permanent Lightsail activation."""
from __future__ import annotations

from decimal import Decimal
import json
import os
from pathlib import Path
import re
import sys
from typing import Any, Mapping

from .review import (
    PROVIDER, PROVIDER_NAME, REGION, STATE_KEY, TERRAFORM,
    Refused, Settings, check_source, digest, policy, require,
)

REPOSITORY = "HamedGithubforwork/QuizForge-AI"
WORKFLOW = ".github/workflows/lightsail-production-repair-inspect.yml"
BUNDLE = "small_3_0"
BLUEPRINT = "ubuntu_24_04"
BUDGET_NAME = "quizforge-monthly-account-cost"
BASE_NAME = "quizforge-production-lightsail"
INSTANCE_NAME = f"{BASE_NAME}-server"

FINAL = frozenset({
    "aws_lightsail_key_pair.operator",
    "aws_lightsail_instance.server",
    "aws_lightsail_static_ip.server",
    "aws_lightsail_static_ip_attachment.server",
    "aws_lightsail_instance_public_ports.server",
    "aws_cognito_user_pool.browser",
    "aws_cognito_user_pool_client.browser",
    "aws_cognito_user_pool_domain.browser",
    "aws_sns_topic.alerts",
    "aws_sns_topic_policy.alerts",
    "aws_sns_topic_subscription.operator",
    "aws_cloudwatch_metric_alarm.status",
    "aws_cloudwatch_log_group.recovery",
    "aws_iam_role.recovery",
    "aws_lambda_function.recovery",
    "aws_iam_role_policy.recovery",
    "aws_lambda_permission.recovery",
    "aws_iam_policy.host_health",
})

REPAIR_CREATES = frozenset({
    "aws_lightsail_instance.server",
    "aws_lightsail_instance_public_ports.server",
    "aws_lightsail_static_ip_attachment.server",
})
EXISTING = FINAL - REPAIR_CREATES

DEFAULT_TAGS = {
    "Project": "QuizForge-AI",
    "Environment": "production-lightsail",
    "Temporary": "false",
}
APPROVED_REFRESH_DRIFT_FIELDS = {
    "aws_cloudwatch_log_group.recovery": frozenset({"tags"}),
    "aws_cloudwatch_metric_alarm.status": frozenset({"insufficient_data_actions", "tags"}),
    "aws_cognito_user_pool.browser": frozenset({"domain", "tags"}),
    "aws_iam_policy.host_health": frozenset({"tags"}),
    "aws_iam_role.recovery": frozenset({"inline_policy", "tags"}),
    "aws_lambda_function.recovery": frozenset({"layers", "tags"}),
    "aws_lightsail_key_pair.operator": frozenset({"tags"}),
    "aws_sns_topic.alerts": frozenset({"tags"}),
}


def trusted_invocation(env: Mapping[str, str]) -> None:
    require(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "UNTRUSTED_INVOCATION")
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
    require(not env.get("ACTIONS_STEP_DEBUG") and not env.get("RUNNER_DEBUG"),
            "DEBUG_MODE_REFUSED")


def _managed_addresses(root: Mapping[str, Any]) -> set[str]:
    return {
        str(resource.get("address"))
        for resource in root.get("resources", [])
        if resource.get("mode") == "managed"
    }


def _changed_top_level_attributes(change: Mapping[str, Any]) -> list[str]:
    """Return only safe Terraform schema attribute names, never attribute values."""
    before = change.get("before")
    after = change.get("after")
    if not isinstance(before, Mapping) or not isinstance(after, Mapping):
        return []

    names: list[str] = []
    for key in sorted(set(before) | set(after)):
        if (
            isinstance(key, str)
            and len(key) <= 80
            and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", key)
            and before.get(key) != after.get(key)
        ):
            names.append(key)
    return names


def _null_to_empty_list(before: Any, after: Any) -> bool:
    return before is None and after == []


def _null_to_empty_tags(before: Any, after: Any) -> bool:
    return before is None and after == {}


def _domain_normalization(before: Any, after: Any, settings: Settings) -> bool:
    expected = f"quizforge-{settings.account}"
    return before == "" and after == expected


def _inline_policy_normalization(
    plan: Mapping[str, Any],
    before: Any,
    after: Any,
) -> bool:
    if before != [] or not isinstance(after, list) or len(after) != 1:
        return False
    entry = after[0]
    if not isinstance(entry, Mapping) or set(entry) != {"name", "policy"}:
        return False
    if not isinstance(entry.get("name"), str) or not entry.get("name"):
        return False
    if not isinstance(entry.get("policy"), str):
        return False

    expected = None
    for item in plan.get("resource_changes", []) or []:
        if not isinstance(item, Mapping):
            continue
        if item.get("address") != "aws_iam_role_policy.recovery":
            continue
        change = item.get("change")
        if not isinstance(change, Mapping) or change.get("actions") != ["no-op"]:
            return False
        value = change.get("after")
        if not isinstance(value, Mapping):
            return False
        expected = value
        break

    if not isinstance(expected, Mapping):
        return False
    expected_name = expected.get("name")
    expected_policy = expected.get("policy")
    if not isinstance(expected_name, str) or not isinstance(expected_policy, str):
        return False
    return (
        entry["name"] == expected_name
        and policy(entry["policy"]) == policy(expected_policy)
    )


def _approved_refresh_drift_count(plan: Mapping[str, Any], settings: Settings) -> int:
    """Privately validate the exact known AWS/provider refresh normalizations."""
    raw = plan.get("resource_drift")
    if not raw:
        return 0
    require(isinstance(raw, list), "UNEXPECTED_PLAN_SIDE_EFFECTS")

    seen: set[str] = set()
    for item in raw:
        require(isinstance(item, Mapping), "UNEXPECTED_PLAN_SIDE_EFFECTS")
        address = item.get("address")
        require(
            isinstance(address, str)
            and address in APPROVED_REFRESH_DRIFT_FIELDS
            and address not in seen,
            "UNEXPECTED_PLAN_SIDE_EFFECTS",
        )
        seen.add(address)
        require(
            item.get("mode") == "managed"
            and item.get("provider_name") == PROVIDER_NAME,
            "UNEXPECTED_PLAN_SIDE_EFFECTS",
        )

        change = item.get("change")
        require(isinstance(change, Mapping), "UNEXPECTED_PLAN_SIDE_EFFECTS")
        require(
            change.get("actions") == ["update"]
            and not change.get("replace_paths")
            and not change.get("importing")
            and not item.get("previous_address")
            and not item.get("deposed"),
            "UNEXPECTED_PLAN_SIDE_EFFECTS",
        )
        before = change.get("before")
        after = change.get("after")
        require(
            isinstance(before, Mapping) and isinstance(after, Mapping),
            "UNEXPECTED_PLAN_SIDE_EFFECTS",
        )

        changed = set(_changed_top_level_attributes(change))
        require(
            bool(changed)
            and changed <= APPROVED_REFRESH_DRIFT_FIELDS[address],
            "UNEXPECTED_PLAN_SIDE_EFFECTS",
        )
        for attribute in changed:
            before_value = before.get(attribute)
            after_value = after.get(attribute)
            if attribute == "tags":
                ok = _null_to_empty_tags(before_value, after_value)
            elif attribute in {"insufficient_data_actions", "layers"}:
                ok = _null_to_empty_list(before_value, after_value)
            elif attribute == "inline_policy":
                ok = _inline_policy_normalization(plan, before_value, after_value)
            elif attribute == "domain":
                ok = _domain_normalization(before_value, after_value, settings)
            else:
                ok = False
            require(ok, "UNEXPECTED_PLAN_SIDE_EFFECTS")

    return len(raw)


def _safe_side_effect_diagnostics(plan: Mapping[str, Any]) -> dict[str, Any]:
    """Return only non-sensitive counts, reviewed addresses, and schema field names."""
    drift = plan.get("resource_drift")
    deferred = plan.get("deferred_changes")
    invocations = plan.get("action_invocations")
    drift_items = drift if isinstance(drift, list) else []
    deferred_items = deferred if isinstance(deferred, list) else []
    invocation_items = invocations if isinstance(invocations, list) else []

    known_drift = sorted({
        str(item.get("address"))
        for item in drift_items
        if isinstance(item, dict) and item.get("address") in FINAL
    })
    known_drift_attributes: dict[str, list[str]] = {}
    for item in drift_items:
        if not isinstance(item, dict) or item.get("address") not in FINAL:
            continue
        address = str(item["address"])
        change = item.get("change")
        attributes = (
            _changed_top_level_attributes(change)
            if isinstance(change, Mapping)
            else []
        )
        known_drift_attributes.setdefault(address, [])
        known_drift_attributes[address] = sorted(
            set(known_drift_attributes[address]) | set(attributes)
        )

    unknown_drift_count = sum(
        1 for item in drift_items
        if not isinstance(item, dict) or item.get("address") not in FINAL
    )

    known_deferred = sorted({
        str(item.get("resource_change", {}).get("address"))
        for item in deferred_items
        if isinstance(item, dict)
        and isinstance(item.get("resource_change"), dict)
        and item["resource_change"].get("address") in FINAL
    })
    unknown_deferred_count = sum(
        1 for item in deferred_items
        if not (
            isinstance(item, dict)
            and isinstance(item.get("resource_change"), dict)
            and item["resource_change"].get("address") in FINAL
        )
    )

    return {
        "resource_drift_count": len(drift_items),
        "known_resource_drift_addresses": known_drift,
        "known_resource_drift_attributes": known_drift_attributes,
        "unexpected_resource_drift_count": unknown_drift_count,
        "deferred_change_count": len(deferred_items),
        "known_deferred_change_addresses": known_deferred,
        "unexpected_deferred_change_count": unknown_deferred_count,
        "action_invocation_count": len(invocation_items),
    }


def _one(values: Mapping[str, Any], key: str, code: str) -> dict[str, Any]:
    item = values.get(key)
    require(isinstance(item, list) and len(item) == 1 and isinstance(item[0], dict), code)
    return item[0]


def _port_contract(values: Mapping[str, Any], settings: Settings) -> None:
    ports = values.get("port_info")
    require(isinstance(ports, list) and len(ports) == 3, "PUBLIC_PORT_SET_MISMATCH")
    by_port = {p.get("from_port"): p for p in ports if isinstance(p, dict)}
    require(set(by_port) == {22, 80, 443}, "PUBLIC_PORT_SET_MISMATCH")
    for number, cidrs in (
        (22, [settings.admin_cidr]),
        (80, ["0.0.0.0/0"]),
        (443, ["0.0.0.0/0"]),
    ):
        item = by_port[number]
        require(item.get("to_port") == number and item.get("protocol") == "tcp",
                "PUBLIC_PORT_SET_MISMATCH")
        require(item.get("cidrs") == cidrs, "PUBLIC_PORT_SCOPE_MISMATCH")
        require(item.get("ipv6_cidrs") in (None, []), "IPV6_PUBLIC_ACCESS_REFUSED")
        require(item.get("cidr_list_aliases") in (None, []), "PUBLIC_PORT_ALIAS_REFUSED")


def _resource_config(configs: list[dict[str, Any]], address: str) -> dict[str, Any]:
    matches = [item for item in configs if item.get("address") == address]
    require(len(matches) == 1, "CONFIGURATION_RESOURCE_MISMATCH")
    return matches[0]


def _references(config: Mapping[str, Any], expression: str) -> set[str]:
    value = config.get("expressions", {}).get(expression, {})
    refs = value.get("references", []) if isinstance(value, dict) else []
    return {str(item) for item in refs}


def _catalog_page(client, method: str, key: str) -> list[dict[str, Any]]:
    token = None
    result: list[dict[str, Any]] = []
    while True:
        args: dict[str, Any] = {"includeInactive": False}
        if token:
            args["pageToken"] = token
        response = getattr(client, method)(**args)
        result.extend(response.get(key, []))
        token = response.get("nextPageToken")
        if not token:
            return result


def check_catalog_and_external_budget(settings: Settings) -> dict[str, Any]:
    import boto3

    sts = boto3.client("sts", region_name=REGION)
    account = sts.get_caller_identity()["Account"]
    require(account == settings.account, "ACCOUNT_MISMATCH")

    lightsail = boto3.client("lightsail", region_name=REGION)
    bundles = [
        item for item in _catalog_page(lightsail, "get_bundles", "bundles")
        if item.get("bundleId") == BUNDLE
    ]
    blueprints = [
        item for item in _catalog_page(lightsail, "get_blueprints", "blueprints")
        if item.get("blueprintId") == BLUEPRINT
    ]
    require(len(bundles) == 1 and bundles[0].get("isActive") is not False,
            "LIGHTSAIL_BUNDLE_UNAVAILABLE")
    require(len(blueprints) == 1 and blueprints[0].get("isActive") is not False,
            "LIGHTSAIL_BLUEPRINT_UNAVAILABLE")

    budgets = boto3.client("budgets", region_name="us-east-1")
    budget = budgets.describe_budget(
        AccountId=account, BudgetName=BUDGET_NAME
    )["Budget"]
    limit = budget.get("BudgetLimit", {})
    require(
        budget.get("BudgetType") == "COST"
        and budget.get("TimeUnit") == "MONTHLY"
        and limit.get("Unit") == "USD"
        and Decimal(str(limit.get("Amount", "-1"))) == Decimal("20"),
        "EXTERNAL_BUDGET_CONTRACT_MISMATCH",
    )

    notices = budgets.describe_notifications_for_budget(
        AccountId=account, BudgetName=BUDGET_NAME, MaxResults=100
    )
    require(not notices.get("NextToken") and len(notices.get("Notifications", [])) == 4,
            "EXTERNAL_BUDGET_NOTIFICATION_MISMATCH")
    for notice in notices.get("Notifications", []):
        request_notice = dict(notice)
        request_notice.setdefault("ThresholdType", "PERCENTAGE")
        subscriber = budgets.describe_subscribers_for_notification(
            AccountId=account,
            BudgetName=BUDGET_NAME,
            Notification={
                "NotificationType": request_notice["NotificationType"],
                "ComparisonOperator": request_notice["ComparisonOperator"],
                "Threshold": request_notice["Threshold"],
                "ThresholdType": request_notice["ThresholdType"],
            },
            MaxResults=100,
        )
        require(
            not subscriber.get("NextToken")
            and subscriber.get("Subscribers")
            == [{"SubscriptionType": "EMAIL", "Address": settings.email}],
            "EXTERNAL_BUDGET_RECIPIENT_MISMATCH",
        )

    return {
        "schema": 1,
        "region": REGION,
        "lightsail_bundle": BUNDLE,
        "lightsail_bundle_available": True,
        "lightsail_blueprint": BLUEPRINT,
        "lightsail_blueprint_available": True,
        "external_budget_name": BUDGET_NAME,
        "external_budget_monthly_usd": 20,
        "external_budget_verified": True,
    }


def review_plan(plan: dict[str, Any], settings: Settings, catalog: dict[str, Any]) -> dict[str, Any]:
    require(catalog.get("lightsail_bundle") == BUNDLE
            and catalog.get("lightsail_bundle_available") is True,
            "LIGHTSAIL_BUNDLE_UNAVAILABLE")
    require(catalog.get("lightsail_blueprint") == BLUEPRINT
            and catalog.get("lightsail_blueprint_available") is True,
            "LIGHTSAIL_BLUEPRINT_UNAVAILABLE")
    require(catalog.get("external_budget_verified") is True
            and catalog.get("external_budget_monthly_usd") == 20,
            "EXTERNAL_BUDGET_NOT_VERIFIED")

    require(isinstance(plan, dict) and plan.get("format_version") == "1.2",
            "PLAN_FORMAT_UNSUPPORTED")
    require(plan.get("terraform_version") == TERRAFORM, "TERRAFORM_VERSION_MISMATCH")
    require(plan.get("errored") is False and plan.get("applyable") is True
            and plan.get("complete") is True, "INCOMPLETE_OR_ERRORED_PLAN")
    side_effects = _safe_side_effect_diagnostics(plan)
    approved_refresh_drift = _approved_refresh_drift_count(plan, settings)
    require(
        approved_refresh_drift == side_effects["resource_drift_count"]
        and side_effects["unexpected_resource_drift_count"] == 0
        and side_effects["deferred_change_count"] == 0
        and side_effects["action_invocation_count"] == 0,
        "UNEXPECTED_PLAN_SIDE_EFFECTS",
    )
    for check in plan.get("checks", []):
        require(check.get("status") == "pass", "PLAN_CHECK_NOT_PASSED")

    variables = plan.get("variables", {})
    require("monthly_budget_usd" not in variables, "DUPLICATE_BUDGET_VARIABLE_REFUSED")
    require(variables.get("alert_email", {}).get("value") == settings.email,
            "RECIPIENT_MISMATCH")
    require(variables.get("ssh_public_key", {}).get("value") == settings.ssh_key,
            "SSH_KEY_MISMATCH")
    require(variables.get("admin_ipv4_cidr", {}).get("value") == settings.admin_cidr,
            "ADMIN_CIDR_MISMATCH")
    require(variables.get("public_signup", {}).get("value") is False,
            "PUBLIC_SIGNUP_MUST_START_DISABLED")

    prior = plan.get("prior_state", {}).get("values", {}).get("root_module", {})
    require(not prior.get("child_modules"), "NESTED_STATE_REFUSED")
    require(_managed_addresses(prior) == set(EXISTING), "PARTIAL_STATE_CONTRACT_MISMATCH")

    root = plan.get("configuration", {}).get("root_module", {})
    require(not root.get("module_calls"), "NESTED_CONFIGURATION_REFUSED")
    configs = root.get("resources", [])
    require(isinstance(configs, list), "CONFIGURATION_MISSING")
    managed_config = {r.get("address") for r in configs if r.get("mode") == "managed"}
    require(managed_config == set(FINAL), "CONFIGURATION_RESOURCE_MISMATCH")
    require(not any(str(r.get("type", "")).startswith("aws_route53") for r in configs),
            "DNS_CHANGE_REFUSED")
    require(not any(r.get("type") == "aws_budgets_budget" for r in configs),
            "DUPLICATE_BUDGET_RESOURCE_REFUSED")

    changes = [item for item in plan.get("resource_changes", [])
               if item.get("mode") == "managed"]
    require({item.get("address") for item in changes} == set(FINAL),
            "RESOURCE_SET_MISMATCH")

    after: dict[str, dict[str, Any]] = {}
    for item in changes:
        address = item.get("address")
        require(item.get("provider_name") == PROVIDER_NAME, "UNEXPECTED_PROVIDER")
        change = item.get("change", {})
        actions = change.get("actions")
        require(not change.get("replace_paths") and not change.get("importing")
                and not item.get("previous_address") and not item.get("deposed"),
                "ADOPTION_OR_REPLACEMENT_REFUSED")
        if address in REPAIR_CREATES:
            require(actions == ["create"] and change.get("before") is None,
                    "REPAIR_CREATES_ONLY")
        else:
            require(address in EXISTING and actions == ["no-op"]
                    and isinstance(change.get("before"), dict),
                    "EXISTING_RESOURCES_MUST_BE_NOOP")
        value = change.get("after")
        require(isinstance(value, dict), "RESOURCE_VALUES_MISSING")
        after[str(address)] = value

    key = after["aws_lightsail_key_pair.operator"]
    require(key.get("name") == "quizforge-production-operator"
            and key.get("public_key") == settings.ssh_key, "SSH_KEY_MISMATCH")
    require(after["aws_lightsail_static_ip.server"].get("name")
            == BASE_NAME, "STATIC_IP_NAME_MISMATCH")

    pool = after["aws_cognito_user_pool.browser"]
    require(pool.get("name") == BASE_NAME
            and pool.get("deletion_protection") == "ACTIVE"
            and pool.get("mfa_configuration") == "ON",
            "COGNITO_POOL_MISMATCH")
    require(_one(pool, "admin_create_user_config", "COGNITO_ADMIN_CONFIG_MISSING")
            .get("allow_admin_create_user_only") is True,
            "PUBLIC_SIGNUP_MUST_START_DISABLED")

    server = after["aws_lightsail_instance.server"]
    for name, expected in {
        "name": INSTANCE_NAME,
        "availability_zone": "ca-central-1a",
        "blueprint_id": BLUEPRINT,
        "bundle_id": BUNDLE,
        "ip_address_type": "ipv4",
        "key_pair_name": "quizforge-production-operator",
    }.items():
        require(server.get(name) == expected, "LIGHTSAIL_SERVER_CONTRACT_MISMATCH")

    _port_contract(after["aws_lightsail_instance_public_ports.server"], settings)

    attachment_cfg = _resource_config(configs, "aws_lightsail_static_ip_attachment.server")
    require("aws_lightsail_static_ip.server.id" in _references(attachment_cfg, "static_ip_name"),
            "STATIC_IP_ATTACHMENT_REFERENCE_MISMATCH")
    require("aws_lightsail_instance.server.id" in _references(attachment_cfg, "instance_name"),
            "STATIC_IP_ATTACHMENT_REFERENCE_MISMATCH")

    ports_cfg = _resource_config(configs, "aws_lightsail_instance_public_ports.server")
    require("aws_lightsail_instance.server.name" in _references(ports_cfg, "instance_name"),
            "PUBLIC_PORT_INSTANCE_REFERENCE_MISMATCH")

    expected_topic = (
        f"arn:aws:sns:{REGION}:{settings.account}:quizforge-production-lightsail-alerts"
    )
    topic_policy = after["aws_sns_topic_policy.alerts"]
    require(topic_policy.get("arn") == expected_topic, "ALERT_TOPIC_POLICY_ARN_MISMATCH")
    expected_policy = policy({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "cloudwatch.amazonaws.com"},
            "Action": "SNS:Publish",
            "Resource": expected_topic,
            "Condition": {"StringEquals": {"AWS:SourceOwner": settings.account}},
        }],
    })
    require(policy(topic_policy.get("policy")) == expected_policy,
            "ALERT_TOPIC_POLICY_MISMATCH")

    manifest = {
        "schema": 1,
        "terraform_version": TERRAFORM,
        "aws_provider_version": PROVIDER,
        "region": REGION,
        "state_key": STATE_KEY,
        "workspace": "default",
        "prior_state_managed_resources": len(EXISTING),
        "existing_resources_noop": len(EXISTING),
        "creates": len(REPAIR_CREATES),
        "updates": 0,
        "deletes": 0,
        "replacements": 0,
        "approved_refresh_drift_entries": approved_refresh_drift,
        "approved_refresh_drift_only": True,
        "create_addresses": sorted(REPAIR_CREATES),
        "lightsail_bundle": BUNDLE,
        "lightsail_bundle_available": True,
        "lightsail_blueprint": BLUEPRINT,
        "lightsail_blueprint_available": True,
        "static_ipv4_attachment_requested": True,
        "ssh_restricted_to_single_operator_ipv4": True,
        "http_https_public": True,
        "public_signup": False,
        "mfa_configuration": "ON",
        "external_budget_managed_separately": True,
        "external_budget_monthly_usd": 20,
        "external_budget_verified": True,
        "lightsail_stack_budget_resources": 0,
        "sns_publishers": ["cloudwatch.amazonaws.com"],
        "dns_changes_requested": False,
        "ai_enablement_requested": False,
        "backup_infrastructure_changes_requested": False,
    }
    return manifest


def _write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    root = Path.cwd()
    results = root / "lightsail-repair-results"
    safe_diagnostics: dict[str, Any] = {}
    try:
        command = sys.argv[1] if len(sys.argv) > 1 else ""
        env = dict(os.environ)
        trusted_invocation(env)
        settings = Settings.from_env(env)
        check_source(root)

        if command == "catalog" and len(sys.argv) == 2:
            value = check_catalog_and_external_budget(settings)
            _write(results / "catalog.json", value)
            _write(results / "summary.json", {
                "schema": 1,
                "operation": "repair_inspect",
                "result": "catalog_verified_plan_pending_no_apply",
                "apply_attempted": False,
                "terraform_apply_completed": False,
            })
            print("Lightsail repair catalog and external budget checks passed.")
            return 0

        if command == "review" and len(sys.argv) == 4:
            plan = json.loads(Path(sys.argv[2]).read_text())
            catalog = json.loads(Path(sys.argv[3]).read_text())
            safe_diagnostics = _safe_side_effect_diagnostics(plan)
            manifest = review_plan(plan, settings, catalog)
            report = {
                "schema": 1,
                "operation": "repair_inspect",
                "result": "repair_inspection_passed_no_apply",
                "apply_attempted": False,
                "terraform_apply_completed": False,
                "repair_manifest_sha256": digest(manifest),
                "safety_manifest": manifest,
            }
            _write(results / "summary.json", report)
            print("Permanent Lightsail repair inspection passed; no apply was attempted.")
            return 0

        raise Refused("UNEXPECTED_ARGUMENTS")
    except Refused as error:
        code = str(error) if re.fullmatch(r"[A-Z0-9_]{1,80}", str(error)) else "REPAIR_REVIEW_REFUSED"
    except Exception:
        code = "PRIVATE_REPAIR_REVIEW_FAILED"

    summary = {
        "schema": 1,
        "operation": "repair_inspect",
        "result": "blocked_no_apply_attempted",
        "apply_attempted": False,
        "terraform_apply_completed": False,
        "error_code": code,
    }
    if code == "UNEXPECTED_PLAN_SIDE_EFFECTS":
        summary["safe_diagnostics"] = safe_diagnostics
    _write(results / "summary.json", summary)
    print("Permanent Lightsail repair inspection refused.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
