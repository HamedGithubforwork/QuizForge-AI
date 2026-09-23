"""Fail-closed review for the permanent Lightsail initial Terraform plan.

This module publishes only static/public contract facts. It never publishes the
private alert recipient, SSH public key, operator IP, AWS account, state bucket,
raw plan, provider diagnostics, credentials, or state.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Mapping

REPOSITORY = "HamedGithubforwork/QuizForge-AI"
WORKFLOW = ".github/workflows/lightsail-production-inspect.yml"
TERRAFORM = "1.14.7"
PROVIDER = "6.64.0"
REGION = "ca-central-1"
STATE_KEY = "quizforge/lightsail-production/terraform.tfstate"
BUDGET_USD = 20
PROVIDER_NAME = "registry.terraform.io/hashicorp/aws"

SOURCE_BLOBS = {
    "infra/aws/lightsail-production/main.tf": "7ff699c9423c7c33adcb2a403b7428d28ac30307",
    "infra/aws/lightsail-production/auth.tf": "ca2ccfcf747e1213a40bd50f06e6f0d1ac0f9f1c",
    "infra/aws/lightsail-production/operations.tf": "ba73e89c9ddf8cf19805a7b89bc0f300f3c799d4",
    "infra/aws/lightsail-production/.terraform.lock.hcl": "38e6eaafe6a597b1adbdee97636732a82fedf820",
    "scripts/production/lightsail/bootstrap.sh": "377641259fdb896c3a01de76f80cf6aa46a0f208",
    "scripts/production/lightsail/package_recovery.py": "4d3763eaa51d3aacda69febfd2c26b32ca71d6fc",
    "scripts/cognito_browser/identity_triggers.py": "c559f11344e16f5243872ff1e9f60b30decba6ac",
    "scripts/cognito_browser/pre_signup.py": "9f67d2f62cd06827ee7505220b263205ecf88c7d",
}

EXPECTED = frozenset({
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
    "aws_budgets_budget.monthly",
    "aws_cloudwatch_metric_alarm.status",
    "aws_cloudwatch_log_group.recovery",
    "aws_iam_role.recovery",
    "aws_lambda_function.recovery",
    "aws_iam_role_policy.recovery",
    "aws_lambda_permission.recovery",
    "aws_iam_policy.host_health",
})


class Refused(RuntimeError):
    """Static public-safe refusal code."""


def require(condition: bool, code: str) -> None:
    if not condition:
        raise Refused(code)


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def git_blob(path: str) -> str:
    return subprocess.check_output(["git", "hash-object", "--", path], text=True).strip()


def check_source(root: Path) -> None:
    for path, expected in SOURCE_BLOBS.items():
        target = root / path
        require(target.is_file() and not target.is_symlink(), "PINNED_SOURCE_MISSING")
        require(git_blob(path) == expected, "PINNED_SOURCE_CHANGED")
    status = subprocess.check_output(
        ["git", "status", "--porcelain", "--untracked-files=no", "--", *SOURCE_BLOBS],
        text=True,
    ).strip()
    require(not status, "PINNED_SOURCE_DIRTY")


class Settings:
    def __init__(self, role: str, state_bucket: str, email: str, ssh_key: str, admin_cidr: str):
        match = re.fullmatch(r"arn:aws:iam::([0-9]{12}):role/[A-Za-z0-9+=,.@_/-]+", role)
        require(match is not None, "PRIVATE_ROLE_SETTING_INVALID")
        require(bool(re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", state_bucket))
                and ".." not in state_bucket and not re.fullmatch(r"[0-9.]+", state_bucket),
                "PRIVATE_STATE_SETTING_INVALID")
        require(bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email))
                and not email.endswith(".invalid") and len(email) <= 254,
                "PRIVATE_RECIPIENT_SETTING_INVALID")
        require(bool(re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [^\r\n]+)?", ssh_key)),
                "PRIVATE_SSH_PUBLIC_KEY_INVALID")
        try:
            network = ipaddress.ip_network(admin_cidr, strict=True)
        except ValueError:
            raise Refused("PRIVATE_ADMIN_CIDR_INVALID") from None
        require(network.version == 4 and network.prefixlen == 32,
                "PRIVATE_ADMIN_CIDR_INVALID")
        self.role = role
        self.account = match.group(1) if match else ""
        self.state_bucket = state_bucket
        self.email = email
        self.ssh_key = ssh_key
        self.admin_cidr = admin_cidr

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Settings":
        return cls(
            env.get("QF_ROLE_ARN", ""),
            env.get("QF_STATE_BUCKET", ""),
            env.get("AWS_BUDGET_ALERT_EMAIL", ""),
            env.get("LIGHTSAIL_SSH_PUBLIC_KEY", ""),
            env.get("LIGHTSAIL_ADMIN_IPV4_CIDR", ""),
        )


def trusted_invocation(env: Mapping[str, str]) -> None:
    require(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "UNTRUSTED_INVOCATION")
    require(env.get("GITHUB_REF") == "refs/heads/main", "UNTRUSTED_INVOCATION")
    require(env.get("GITHUB_REPOSITORY") == REPOSITORY, "UNTRUSTED_INVOCATION")
    require(env.get("GITHUB_WORKFLOW_REF") == f"{REPOSITORY}/{WORKFLOW}@refs/heads/main",
            "UNTRUSTED_INVOCATION")
    sha = env.get("GITHUB_SHA", "")
    require(bool(re.fullmatch(r"[0-9a-f]{40}", sha)), "UNTRUSTED_WORKFLOW_REVISION")
    require(env.get("GITHUB_WORKFLOW_SHA") == sha, "UNTRUSTED_WORKFLOW_REVISION")
    require(env.get("TF_WORKSPACE", "default") == "default", "NONDEFAULT_WORKSPACE")
    require(not env.get("ACTIONS_STEP_DEBUG") and not env.get("RUNNER_DEBUG"), "DEBUG_MODE_REFUSED")


def policy(value: Any) -> Any:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            raise Refused("POLICY_JSON_INVALID") from None
    def norm(item: Any, key: str = "") -> Any:
        if key in {"Action", "Resource", "Statement"} and not isinstance(item, list):
            item = [item]
        if isinstance(item, dict):
            return {k: norm(v, k) for k, v in item.items()}
        if isinstance(item, list):
            return sorted((norm(v) for v in item), key=canonical)
        return item
    return norm(value)


def _managed_changes(plan: dict) -> dict[str, dict]:
    changes = plan.get("resource_changes", [])
    require(isinstance(changes, list), "RESOURCE_CHANGES_MISSING")
    managed = [r for r in changes if r.get("mode") == "managed"]
    require(len(managed) == len(EXPECTED), "EXPECTED_19_RESOURCES")
    require({r.get("address") for r in managed} == EXPECTED, "RESOURCE_SET_MISMATCH")
    result = {}
    for r in managed:
        address = r.get("address")
        require(r.get("provider_name") == PROVIDER_NAME, "UNEXPECTED_PROVIDER")
        change = r.get("change", {})
        require(change.get("actions") == ["create"] and change.get("before") is None,
                "INITIAL_CREATES_ONLY")
        require(not change.get("replace_paths") and not change.get("importing")
                and not r.get("previous_address") and not r.get("deposed"),
                "ADOPTION_OR_REPLACEMENT_REFUSED")
        after = change.get("after")
        require(isinstance(after, dict), "RESOURCE_VALUES_MISSING")
        result[address] = after
    return result


def _eq(value: Any, expected: Any, code: str) -> None:
    require(type(value) is type(expected) or (
        type(expected) in {int, float} and type(value) in {int, float}
    ), code)
    require(value == expected, code)


def _port_contract(values: dict, settings: Settings) -> None:
    ports = values.get("port_info")
    require(isinstance(ports, list) and len(ports) == 3, "PUBLIC_PORT_SET_MISMATCH")
    by_port = {p.get("from_port"): p for p in ports if isinstance(p, dict)}
    require(set(by_port) == {22, 80, 443}, "PUBLIC_PORT_SET_MISMATCH")
    for number, cidrs in ((22, [settings.admin_cidr]), (80, ["0.0.0.0/0"]), (443, ["0.0.0.0/0"])):
        p = by_port[number]
        require(p.get("to_port") == number and p.get("protocol") == "tcp", "PUBLIC_PORT_SET_MISMATCH")
        require(p.get("cidrs") == cidrs, "PUBLIC_PORT_SCOPE_MISMATCH")
        require(p.get("ipv6_cidrs") in (None, []), "IPV6_PUBLIC_ACCESS_REFUSED")
        require(p.get("cidr_list_aliases") in (None, []), "PUBLIC_PORT_ALIAS_REFUSED")


def _nested_one(values: dict, key: str, code: str) -> dict:
    item = values.get(key)
    require(isinstance(item, list) and len(item) == 1 and isinstance(item[0], dict), code)
    return item[0]


def review_plan(plan: dict, settings: Settings) -> dict:
    require(isinstance(plan, dict) and plan.get("format_version") == "1.2", "PLAN_FORMAT_UNSUPPORTED")
    require(plan.get("terraform_version") == TERRAFORM, "TERRAFORM_VERSION_MISMATCH")
    require(plan.get("errored") is False and plan.get("applyable") is True
            and plan.get("complete") is True, "INCOMPLETE_OR_ERRORED_PLAN")
    require(not plan.get("deferred_changes") and not plan.get("resource_drift")
            and not plan.get("action_invocations"), "UNEXPECTED_PLAN_SIDE_EFFECTS")
    for check in plan.get("checks", []):
        require(check.get("status") == "pass", "PLAN_CHECK_NOT_PASSED")

    prior = plan.get("prior_state", {}).get("values", {}).get("root_module", {})
    require(not prior.get("child_modules") and not any(
        r.get("mode") == "managed" for r in prior.get("resources", [])),
        "INITIAL_STATE_NOT_EMPTY")

    variables = plan.get("variables", {})
    require(variables.get("monthly_budget_usd", {}).get("value") == BUDGET_USD,
            "BUDGET_MISMATCH")
    require(variables.get("alert_email", {}).get("value") == settings.email,
            "RECIPIENT_MISMATCH")
    require(variables.get("ssh_public_key", {}).get("value") == settings.ssh_key,
            "SSH_KEY_MISMATCH")
    require(variables.get("admin_ipv4_cidr", {}).get("value") == settings.admin_cidr,
            "ADMIN_CIDR_MISMATCH")
    require(variables.get("public_signup", {}).get("value") is False,
            "PUBLIC_SIGNUP_MUST_START_DISABLED")

    root = plan.get("configuration", {}).get("root_module", {})
    require(not root.get("module_calls"), "NESTED_CONFIGURATION_REFUSED")
    configs = root.get("resources", [])
    require(isinstance(configs, list), "CONFIGURATION_MISSING")
    require({r.get("address") for r in configs if r.get("mode") == "managed"} == EXPECTED,
            "CONFIGURATION_RESOURCE_MISMATCH")
    require(not any(str(r.get("type", "")).startswith("aws_route53") for r in configs),
            "DNS_CHANGE_REFUSED")

    values = _managed_changes(plan)

    key = values["aws_lightsail_key_pair.operator"]
    _eq(key.get("name"), "quizforge-production-operator", "KEY_PAIR_NAME_MISMATCH")
    _eq(key.get("public_key"), settings.ssh_key, "SSH_KEY_MISMATCH")

    server = values["aws_lightsail_instance.server"]
    for name, expected in {
        "name": "quizforge-production-lightsail",
        "availability_zone": "ca-central-1a",
        "blueprint_id": "ubuntu_24_04",
        "bundle_id": "small_3_0",
        "ip_address_type": "ipv4",
        "key_pair_name": "quizforge-production-operator",
    }.items():
        _eq(server.get(name), expected, "LIGHTSAIL_SERVER_CONTRACT_MISMATCH")

    _eq(values["aws_lightsail_static_ip.server"].get("name"),
        "quizforge-production-lightsail", "STATIC_IP_NAME_MISMATCH")
    _port_contract(values["aws_lightsail_instance_public_ports.server"], settings)

    pool = values["aws_cognito_user_pool.browser"]
    _eq(pool.get("name"), "quizforge-production-lightsail", "COGNITO_POOL_MISMATCH")
    _eq(pool.get("deletion_protection"), "ACTIVE", "COGNITO_DELETION_PROTECTION_MISMATCH")
    _eq(pool.get("mfa_configuration"), "ON", "COGNITO_MFA_MISMATCH")
    require(_nested_one(pool, "admin_create_user_config", "COGNITO_ADMIN_CONFIG_MISSING")
            .get("allow_admin_create_user_only") is True,
            "PUBLIC_SIGNUP_MUST_START_DISABLED")

    client = values["aws_cognito_user_pool_client.browser"]
    _eq(client.get("name"), "quizforge-production-pkce", "COGNITO_CLIENT_MISMATCH")
    require(client.get("generate_secret") is False, "COGNITO_CLIENT_SECRET_REFUSED")
    require(set(client.get("callback_urls") or []) == {"https://quizfromnotes.com/auth/callback"},
            "COGNITO_CALLBACK_MISMATCH")
    require(set(client.get("logout_urls") or []) == {"https://quizfromnotes.com/"},
            "COGNITO_LOGOUT_MISMATCH")
    require(set(client.get("allowed_oauth_flows") or []) == {"code"}, "COGNITO_FLOW_MISMATCH")

    domain = values["aws_cognito_user_pool_domain.browser"].get("domain")
    _eq(domain, f"quizforge-{settings.account}", "COGNITO_DOMAIN_MISMATCH")

    topic = values["aws_sns_topic.alerts"]
    _eq(topic.get("name"), "quizforge-production-lightsail-alerts", "ALERT_TOPIC_MISMATCH")
    subscription = values["aws_sns_topic_subscription.operator"]
    _eq(subscription.get("protocol"), "email", "ALERT_PROTOCOL_MISMATCH")
    _eq(subscription.get("endpoint"), settings.email, "RECIPIENT_MISMATCH")

    budget = values["aws_budgets_budget.monthly"]
    _eq(budget.get("name"), "quizforge-monthly-account-cost", "BUDGET_NAME_MISMATCH")
    require(str(budget.get("limit_amount")) in {"20", "20.0"}, "BUDGET_MISMATCH")
    _eq(budget.get("limit_unit"), "USD", "BUDGET_UNIT_MISMATCH")
    _eq(budget.get("budget_type"), "COST", "BUDGET_TYPE_MISMATCH")
    _eq(budget.get("time_unit"), "MONTHLY", "BUDGET_TIME_MISMATCH")

    alarm = values["aws_cloudwatch_metric_alarm.status"]
    _eq(alarm.get("alarm_name"), "quizforge-production-lightsail-status-failed", "HOST_ALARM_MISMATCH")
    _eq(alarm.get("namespace"), "QuizForge/Host", "HOST_ALARM_MISMATCH")
    _eq(alarm.get("metric_name"), "Healthy", "HOST_ALARM_MISMATCH")
    _eq(alarm.get("treat_missing_data"), "breaching", "HOST_ALARM_MISMATCH")
    _eq(alarm.get("period"), 300, "HOST_ALARM_MISMATCH")
    _eq(alarm.get("evaluation_periods"), 2, "HOST_ALARM_MISMATCH")

    _eq(values["aws_cloudwatch_log_group.recovery"].get("retention_in_days"), 14,
        "RECOVERY_LOG_RETENTION_MISMATCH")

    role = values["aws_iam_role.recovery"]
    _eq(role.get("name"), "quizforge-production-lightsail-recovery", "RECOVERY_ROLE_MISMATCH")
    trust = policy(role.get("assume_role_policy"))
    expected_trust = policy({"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"},
        "Action": "sts:AssumeRole"
    }]})
    require(trust == expected_trust, "RECOVERY_ROLE_TRUST_MISMATCH")

    function = values["aws_lambda_function.recovery"]
    _eq(function.get("function_name"), "quizforge-production-lightsail-recovery", "RECOVERY_LAMBDA_MISMATCH")
    _eq(function.get("runtime"), "python3.13", "RECOVERY_LAMBDA_MISMATCH")
    _eq(function.get("handler"), "identity_triggers.handler", "RECOVERY_LAMBDA_MISMATCH")
    _eq(function.get("memory_size"), 128, "RECOVERY_LAMBDA_MISMATCH")
    _eq(function.get("timeout"), 5, "RECOVERY_LAMBDA_MISMATCH")

    health = values["aws_iam_policy.host_health"]
    _eq(health.get("name"), "quizforge-production-host-health", "HEALTH_POLICY_NAME_MISMATCH")
    expected_health = policy({"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Action": ["cloudwatch:PutMetricData"], "Resource": "*",
        "Condition": {"StringEquals": {"cloudwatch:namespace": "QuizForge/Host"}}
    }]})
    require(policy(health.get("policy")) == expected_health, "HEALTH_POLICY_MISMATCH")

    manifest = {
        "schema": 1,
        "terraform_version": TERRAFORM,
        "aws_provider_version": PROVIDER,
        "region": REGION,
        "state_key": STATE_KEY,
        "workspace": "default",
        "creates": 19,
        "updates": 0,
        "deletes": 0,
        "replacements": 0,
        "lightsail_bundle": "small_3_0",
        "lightsail_blueprint": "ubuntu_24_04",
        "static_ipv4_requested": True,
        "ssh_restricted_to_single_operator_ipv4": True,
        "http_https_public": True,
        "public_signup": False,
        "mfa_configuration": "ON",
        "monthly_aws_alert_budget_usd": BUDGET_USD,
        "private_recipient_matches_current_secret": True,
        "operator_ssh_key_matches_current_secret": True,
        "operator_ipv4_matches_current_secret": True,
        "dns_changes_requested": False,
        "ai_enablement_requested": False,
        "backup_infrastructure_changes_requested": False,
    }
    return manifest


def report_success(manifest: dict) -> dict:
    return {
        "schema": 1,
        "operation": "inspect",
        "result": "inspection_passed_no_apply",
        "apply_attempted": False,
        "terraform_apply_completed": False,
        "review_manifest_sha256": digest(manifest),
        "safety_manifest": manifest,
    }


def main() -> int:
    root = Path.cwd()
    if sys.argv[1:] == ["check-source"]:
        try:
            check_source(root)
            print("Pinned permanent Lightsail source checks passed.")
            return 0
        except Exception:
            print("Pinned permanent Lightsail source check refused.", file=sys.stderr)
            return 1
    if len(sys.argv) != 2:
        print("Permanent Lightsail plan review refused.", file=sys.stderr)
        return 1

    output = root / "lightsail-inspection-results/summary.json"
    output.parent.mkdir(exist_ok=True)
    report = {
        "schema": 1, "operation": "inspect", "result": "blocked_no_apply_attempted",
        "apply_attempted": False, "terraform_apply_completed": False,
    }
    try:
        env = dict(os.environ)
        trusted_invocation(env)
        settings = Settings.from_env(env)
        check_source(root)
        plan = json.loads(Path(sys.argv[1]).read_text())
        report = report_success(review_plan(plan, settings))
        code = 0
    except Refused as error:
        report["error_code"] = str(error) if re.fullmatch(r"[A-Z0-9_]{1,80}", str(error)) else "PLAN_REVIEW_REFUSED"
        code = 1
    except Exception:
        report["error_code"] = "PRIVATE_PLAN_REVIEW_FAILED"
        code = 1
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print("Permanent Lightsail inspection finished; review only the sanitized summary.")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
