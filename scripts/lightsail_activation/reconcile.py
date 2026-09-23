"""Read-only reconciliation of partial permanent Lightsail activation."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys
from typing import Any

try:
    from botocore.exceptions import ClientError
except ModuleNotFoundError:  # Credential-free unit discovery does not install AWS SDK.
    class ClientError(Exception):
        pass

from .review import EXPECTED, REGION, STATE_KEY, Refused, Settings, require

RESULT = Path("lightsail-reconciliation-results/summary.json")
NAME = "quizforge-production-lightsail"
TOPIC_NAME = f"{NAME}-alerts"
BUDGET_NAME = "quizforge-monthly-account-cost"
ALARM_NAME = f"{NAME}-status-failed"
LOG_GROUP = f"/aws/lambda/{NAME}-recovery"
RECOVERY_ROLE = f"{NAME}-recovery"
RECOVERY_FUNCTION = f"{NAME}-recovery"
HEALTH_POLICY = "quizforge-production-host-health"
KEY_PAIR = "quizforge-production-operator"


def _not_found(error: ClientError) -> bool:
    code = error.response.get("Error", {}).get("Code", "")
    return code in {
        "NoSuchKey", "404", "NotFound", "NotFoundException",
        "ResourceNotFound", "ResourceNotFoundException",
        "NoSuchEntity", "NoSuchEntityException",
        "AccessPointNotFoundException", "InvalidParameterValueException",
    }


def _json_policy(value: Any) -> Any:
    if isinstance(value, str):
        return json.loads(value)
    return value


def state_addresses(document: dict[str, Any]) -> set[str]:
    result: set[str] = set()
    for resource in document.get("resources", []):
        if resource.get("mode") != "managed":
            continue
        if not resource.get("instances"):
            continue
        prefix = (resource.get("module") + ".") if resource.get("module") else ""
        result.add(prefix + resource.get("type", "") + "." + resource.get("name", ""))
    return result


def classify(state: set[str], live: set[str]) -> str:
    if not state and not live:
        return "no_resources_found"
    if state == set(EXPECTED) and live == set(EXPECTED):
        return "state_and_live_complete"
    if state == live:
        return "matching_partial_state_and_live_resources"
    return "state_live_mismatch_partial_resources"


def write_report(report: dict[str, Any], settings: Settings | None = None) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if settings:
        for private in (
            settings.role, settings.account, settings.state_bucket, settings.email,
            settings.ssh_key, settings.admin_cidr,
        ):
            require(private not in raw, "PUBLIC_SUMMARY_REDACTION_FAILED")
    RESULT.parent.mkdir(exist_ok=True)
    tmp = RESULT.with_suffix(".tmp")
    tmp.write_text(raw, encoding="utf-8")
    tmp.replace(RESULT)


def _find_topic(sns, suffix: str) -> str | None:
    token = None
    matches = []
    while True:
        args = {}
        if token:
            args["NextToken"] = token
        response = sns.list_topics(**args)
        for topic in response.get("Topics", []):
            arn = topic.get("TopicArn", "")
            if arn.endswith(":" + suffix):
                matches.append(arn)
        token = response.get("NextToken")
        if not token:
            break
    require(len(matches) <= 1, "DUPLICATE_NAMED_RESOURCE")
    return matches[0] if matches else None


def _find_pool(cognito, name: str) -> dict[str, Any] | None:
    token = None
    matches = []
    while True:
        args = {"MaxResults": 60}
        if token:
            args["NextToken"] = token
        response = cognito.list_user_pools(**args)
        matches.extend(p for p in response.get("UserPools", []) if p.get("Name") == name)
        token = response.get("NextToken")
        if not token:
            break
    require(len(matches) <= 1, "DUPLICATE_NAMED_RESOURCE")
    return matches[0] if matches else None


def read_remote_state(s3, settings: Settings) -> tuple[bool, bool, set[str]]:
    present = False
    locked = False
    addresses: set[str] = set()
    try:
        response = s3.get_object(Bucket=settings.state_bucket, Key=STATE_KEY)
        raw = response["Body"].read()
        document = json.loads(raw)
        present = True
        addresses = state_addresses(document)
    except ClientError as error:
        if not _not_found(error):
            raise
    try:
        s3.head_object(Bucket=settings.state_bucket, Key=STATE_KEY + ".tflock")
        locked = True
    except ClientError as error:
        if not _not_found(error):
            raise
    return present, locked, addresses


def aws_inventory(settings: Settings) -> tuple[set[str], dict[str, Any]]:
    import boto3

    live: set[str] = set()
    checks: dict[str, Any] = {
        "instance_contract_ok": False,
        "static_ip_attached": False,
        "public_ports_contract_ok": False,
        "cognito_mfa_on": False,
        "public_signup_disabled": False,
        "cognito_client_contract_ok": False,
        "sns_topic_policy_contract_ok": False,
        "budget_notifications_contract_ok": False,
        "host_alarm_contract_ok": False,
        "recovery_role_policy_contract_ok": False,
        "lambda_permission_contract_ok": False,
        "host_health_policy_contract_ok": False,
        "subscription_state": "missing",
    }

    sts = boto3.client("sts", region_name=REGION)
    account = sts.get_caller_identity()["Account"]
    require(account == settings.account, "ACCOUNT_MISMATCH")

    lightsail = boto3.client("lightsail", region_name=REGION)
    try:
        lightsail.get_key_pair(keyPairName=KEY_PAIR)
        live.add("aws_lightsail_key_pair.operator")
    except ClientError as error:
        if not _not_found(error):
            raise

    try:
        instance = lightsail.get_instance(instanceName=NAME)["instance"]
        live.add("aws_lightsail_instance.server")
        checks["instance_contract_ok"] = (
            instance.get("blueprintId") == "ubuntu_24_04"
            and instance.get("bundleId") == "small_3_0"
            and instance.get("location", {}).get("availabilityZone") == "ca-central-1a"
        )
    except ClientError as error:
        if not _not_found(error):
            raise

    try:
        static = lightsail.get_static_ip(staticIpName=NAME)["staticIp"]
        live.add("aws_lightsail_static_ip.server")
        if static.get("attachedTo") == NAME:
            live.add("aws_lightsail_static_ip_attachment.server")
            checks["static_ip_attached"] = True
    except ClientError as error:
        if not _not_found(error):
            raise

    try:
        states = lightsail.get_instance_port_states(instanceName=NAME).get("portStates", [])
        normalized = {
            (
                p.get("fromPort"), p.get("toPort"), p.get("protocol"),
                tuple(sorted(p.get("cidrs") or [])),
                tuple(sorted(p.get("ipv6Cidrs") or [])),
                tuple(sorted(p.get("cidrListAliases") or [])),
            )
            for p in states
        }
        expected_ports = {
            (22, 22, "tcp", (settings.admin_cidr,), (), ()),
            (80, 80, "tcp", ("0.0.0.0/0",), (), ()),
            (443, 443, "tcp", ("0.0.0.0/0",), (), ()),
        }
        if normalized == expected_ports:
            live.add("aws_lightsail_instance_public_ports.server")
            checks["public_ports_contract_ok"] = True
    except ClientError as error:
        if not _not_found(error):
            raise

    cognito = boto3.client("cognito-idp", region_name=REGION)
    pool = _find_pool(cognito, NAME)
    pool_id = None
    if pool:
        pool_id = pool["Id"]
        desc = cognito.describe_user_pool(UserPoolId=pool_id)["UserPool"]
        live.add("aws_cognito_user_pool.browser")
        checks["cognito_mfa_on"] = desc.get("MfaConfiguration") == "ON"
        checks["public_signup_disabled"] = (
            desc.get("AdminCreateUserConfig", {}).get("AllowAdminCreateUserOnly") is True
        )

        clients = cognito.list_user_pool_clients(
            UserPoolId=pool_id, MaxResults=60
        ).get("UserPoolClients", [])
        named = [c for c in clients if c.get("ClientName") == "quizforge-production-pkce"]
        require(len(named) <= 1, "DUPLICATE_NAMED_RESOURCE")
        if named:
            client = cognito.describe_user_pool_client(
                UserPoolId=pool_id, ClientId=named[0]["ClientId"]
            )["UserPoolClient"]
            live.add("aws_cognito_user_pool_client.browser")
            checks["cognito_client_contract_ok"] = (
                client.get("GenerateSecret") is False
                and set(client.get("CallbackURLs") or []) == {
                    "https://quizfromnotes.com/auth/callback"
                }
                and set(client.get("LogoutURLs") or []) == {"https://quizfromnotes.com/"}
                and set(client.get("AllowedOAuthFlows") or []) == {"code"}
            )

    domain = f"quizforge-{account}"
    try:
        domain_desc = cognito.describe_user_pool_domain(Domain=domain)
        if domain_desc.get("DomainDescription", {}).get("UserPoolId") == pool_id and pool_id:
            live.add("aws_cognito_user_pool_domain.browser")
    except ClientError as error:
        if not _not_found(error):
            raise

    sns = boto3.client("sns", region_name=REGION)
    topic = _find_topic(sns, TOPIC_NAME)
    if topic:
        live.add("aws_sns_topic.alerts")
        attrs = sns.get_topic_attributes(TopicArn=topic).get("Attributes", {})
        policy_text = attrs.get("Policy", "")
        if "budgets.amazonaws.com" in policy_text and "cloudwatch.amazonaws.com" in policy_text:
            live.add("aws_sns_topic_policy.alerts")
            checks["sns_topic_policy_contract_ok"] = True

        token = None
        matches = []
        while True:
            args = {"TopicArn": topic}
            if token:
                args["NextToken"] = token
            response = sns.list_subscriptions_by_topic(**args)
            matches.extend(
                item for item in response.get("Subscriptions", [])
                if item.get("Protocol") == "email" and item.get("Endpoint") == settings.email
            )
            token = response.get("NextToken")
            if not token:
                break
        require(len(matches) <= 1, "DUPLICATE_NAMED_RESOURCE")
        if matches:
            live.add("aws_sns_topic_subscription.operator")
            arn = matches[0].get("SubscriptionArn", "")
            checks["subscription_state"] = (
                "pending" if arn == "PendingConfirmation" else "confirmed"
            )

    budgets = boto3.client("budgets", region_name="us-east-1")
    try:
        budget = budgets.describe_budget(
            AccountId=account, BudgetName=BUDGET_NAME
        )["Budget"]
        live.add("aws_budgets_budget.monthly")
        notifications = budgets.describe_notifications_for_budget(
            AccountId=account, BudgetName=BUDGET_NAME
        ).get("Notifications", [])
        actual = {
            float(n.get("Threshold"))
            for n in notifications
            if n.get("NotificationType") == "ACTUAL"
            and n.get("ThresholdType") == "PERCENTAGE"
            and n.get("ComparisonOperator") == "GREATER_THAN"
        }
        forecast = {
            float(n.get("Threshold"))
            for n in notifications
            if n.get("NotificationType") == "FORECASTED"
            and n.get("ThresholdType") == "PERCENTAGE"
            and n.get("ComparisonOperator") == "GREATER_THAN"
        }
        checks["budget_notifications_contract_ok"] = (
            str(budget.get("BudgetLimit", {}).get("Amount")) in {"20", "20.0"}
            and actual == {50.0, 80.0, 100.0}
            and forecast == {100.0}
        )
    except ClientError as error:
        if not _not_found(error):
            raise

    cloudwatch = boto3.client("cloudwatch", region_name=REGION)
    alarms = cloudwatch.describe_alarms(AlarmNames=[ALARM_NAME]).get("MetricAlarms", [])
    if len(alarms) == 1:
        live.add("aws_cloudwatch_metric_alarm.status")
        alarm = alarms[0]
        checks["host_alarm_contract_ok"] = (
            alarm.get("Namespace") == "QuizForge/Host"
            and alarm.get("MetricName") == "Healthy"
            and alarm.get("TreatMissingData") == "breaching"
            and alarm.get("Period") == 300
            and alarm.get("EvaluationPeriods") == 2
        )

    logs = boto3.client("logs", region_name=REGION)
    groups = logs.describe_log_groups(
        logGroupNamePrefix=LOG_GROUP, limit=50
    ).get("logGroups", [])
    exact_groups = [g for g in groups if g.get("logGroupName") == LOG_GROUP]
    if len(exact_groups) == 1:
        live.add("aws_cloudwatch_log_group.recovery")

    iam = boto3.client("iam")
    try:
        iam.get_role(RoleName=RECOVERY_ROLE)
        live.add("aws_iam_role.recovery")
        inline = iam.list_role_policies(RoleName=RECOVERY_ROLE).get("PolicyNames", [])
        for name in inline:
            doc = iam.get_role_policy(RoleName=RECOVERY_ROLE, PolicyName=name)["PolicyDocument"]
            raw = json.dumps(doc, sort_keys=True)
            if "AdminUserGlobalSignOut" in raw and "logs:PutLogEvents" in raw:
                live.add("aws_iam_role_policy.recovery")
                checks["recovery_role_policy_contract_ok"] = True
                break
    except ClientError as error:
        if not _not_found(error):
            raise

    lambda_client = boto3.client("lambda", region_name=REGION)
    try:
        function = lambda_client.get_function(FunctionName=RECOVERY_FUNCTION)["Configuration"]
        if function.get("Runtime") == "python3.13" and function.get("Handler") == "identity_triggers.handler":
            live.add("aws_lambda_function.recovery")
        try:
            policy_doc = json.loads(lambda_client.get_policy(FunctionName=RECOVERY_FUNCTION)["Policy"])
            raw = json.dumps(policy_doc, sort_keys=True)
            if "cognito-idp.amazonaws.com" in raw and "lambda:InvokeFunction" in raw:
                live.add("aws_lambda_permission.recovery")
                checks["lambda_permission_contract_ok"] = True
        except ClientError as error:
            if not _not_found(error):
                raise
    except ClientError as error:
        if not _not_found(error):
            raise

    policy_arn = f"arn:aws:iam::{account}:policy/{HEALTH_POLICY}"
    try:
        policy = iam.get_policy(PolicyArn=policy_arn)["Policy"]
        version = iam.get_policy_version(
            PolicyArn=policy_arn, VersionId=policy["DefaultVersionId"]
        )["PolicyVersion"]["Document"]
        raw = json.dumps(version, sort_keys=True)
        live.add("aws_iam_policy.host_health")
        checks["host_health_policy_contract_ok"] = (
            "cloudwatch:PutMetricData" in raw and "QuizForge/Host" in raw
        )
    except ClientError as error:
        if not _not_found(error):
            raise

    return live, checks


def main() -> int:
    report = {
        "schema": 1,
        "operation": "reconcile_read_only",
        "result": "read_failed",
        "changes_performed": False,
        "terraform_apply_attempted": False,
    }
    settings: Settings | None = None
    try:
        settings = Settings.from_env(os.environ)
        import boto3
        s3 = boto3.client("s3", region_name=REGION)
        state_present, state_lock_present, state = read_remote_state(s3, settings)
        live, checks = aws_inventory(settings)

        expected = set(EXPECTED)
        report.update({
            "result": classify(state, live),
            "state_object_present": state_present,
            "state_lock_present": state_lock_present,
            "state_managed_resource_count": len(state & expected),
            "state_present": sorted(state & expected),
            "state_missing": sorted(expected - state),
            "state_unexpected": sorted(state - expected),
            "aws_managed_resource_count": len(live & expected),
            "aws_present": sorted(live & expected),
            "aws_missing": sorted(expected - live),
            "state_only": sorted((state - live) & expected),
            "aws_only": sorted((live - state) & expected),
            "checks": checks,
            "changes_performed": False,
            "terraform_apply_attempted": False,
        })
        write_report(report, settings)
        return 0
    except Refused as error:
        report["error_code"] = (
            str(error) if re.fullmatch(r"[A-Z0-9_]{1,80}", str(error))
            else "RECONCILIATION_REFUSED"
        )
    except Exception:
        report["error_code"] = "PRIVATE_READ_FAILED"
    try:
        write_report(report, settings)
    except Exception:
        RESULT.unlink(missing_ok=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
