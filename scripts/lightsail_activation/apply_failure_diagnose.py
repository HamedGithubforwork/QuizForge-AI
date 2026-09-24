"""Read-only root-cause diagnostic for the failed permanent Lightsail repair apply."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import fnmatch
import json
import os
from pathlib import Path
import re
import sys
from typing import Any, Iterable, Mapping

try:
    from botocore.exceptions import ClientError
except ModuleNotFoundError:
    class ClientError(Exception):
        response: dict[str, Any] = {}

from .repair_review import BLUEPRINT, BUNDLE, DEFAULT_TAGS, FINAL, REPOSITORY
from .review import REGION, Refused, Settings, check_source, require

WORKFLOW = ".github/workflows/lightsail-production-apply-failure-diagnostic.yml"
RESULT = Path("lightsail-apply-failure-diagnostic/summary.json")
INSTANCE_NAME = "quizforge-production-lightsail"

INCIDENT_START = datetime(2026, 9, 24, 0, 35, 0, tzinfo=timezone.utc)
INCIDENT_END = datetime(2026, 9, 24, 0, 37, 30, tzinfo=timezone.utc)
RECENT_START = INCIDENT_START - timedelta(days=7)

KNOWN_ACTIONS = {
    "lightsail:CreateInstances",
    "lightsail:PutInstancePublicPorts",
    "lightsail:AttachStaticIp",
    "lightsail:AllocateStaticIp",
    "lightsail:CreateKeyPair",
    "lightsail:TagResource",
}
KNOWN_EVENT_NAMES = {
    "CreateInstances",
    "PutInstancePublicPorts",
    "AttachStaticIp",
    "AllocateStaticIp",
    "CreateKeyPair",
    "TagResource",
}
SAFE_CONTEXT_KEYS = {
    "aws:RequestedRegion",
    "aws:RequestTag/Project",
    "aws:RequestTag/Environment",
    "aws:RequestTag/Temporary",
    "aws:RequestTag/Purpose",
    "aws:RequestTag/TestId",
    "aws:RequestTag/DeleteAfter",
    "aws:TagKeys",
}
SAFE_CONDITION_KEYS = SAFE_CONTEXT_KEYS | {
    "aws:ResourceTag/Purpose",
    "aws:ResourceTag/Project",
    "aws:ResourceTag/Environment",
    "aws:ResourceTag/Temporary",
}


def trusted(env: Mapping[str, str]) -> None:
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
    require(not env.get("ACTIONS_STEP_DEBUG") and not env.get("RUNNER_DEBUG"), "DEBUG_MODE_REFUSED")


def safe_code(value: Any, fallback: str = "UNKNOWN") -> str:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:-]{1,120}", text) else fallback


def write_report(report: Mapping[str, Any], settings: Settings | None = None) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if settings:
        for private in (
            settings.role,
            settings.account,
            settings.state_bucket,
            settings.email,
            settings.ssh_key,
            settings.admin_cidr,
        ):
            require(private not in raw, "PUBLIC_SUMMARY_REDACTION_FAILED")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    tmp = RESULT.with_suffix(".tmp")
    tmp.write_text(raw, encoding="utf-8")
    tmp.replace(RESULT)


def classify_error(code: str, message: str) -> str:
    haystack = (code + " " + message).lower()
    if any(x in haystack for x in ("accessdenied", "unauthorized", "not authorized", "forbidden")):
        return "authorization"
    if any(x in haystack for x in ("limit", "quota", "too many", "servicequota")):
        return "service_limit_or_quota"
    if any(x in haystack for x in ("throttl", "rate exceeded")):
        return "throttling"
    if any(x in haystack for x in ("invalid", "validation", "malformed", "bad request")):
        return "invalid_request"
    if any(x in haystack for x in ("unavailable", "capacity", "insufficient", "temporar")):
        return "availability_or_capacity"
    if any(x in haystack for x in ("conflict", "already exists", "duplicate")):
        return "conflict"
    return "unknown"


def denied_action_from_message(message: str) -> str | None:
    for action in sorted(KNOWN_ACTIONS):
        if action.lower() in message.lower():
            return action
    return None


def invalid_input_detail(message: str) -> dict[str, Any]:
    """Expose only a redacted template and fixed keyword booleans for InvalidInput errors."""
    lower = message.lower()
    mentions = {
        "account": any(x in lower for x in ("account", "subscription")),
        "availability_zone": any(x in lower for x in ("availability zone", "availabilityzone", "zone")),
        "blueprint": "blueprint" in lower or "image" in lower,
        "bundle": "bundle" in lower or "plan" in lower,
        "instance_name": any(x in lower for x in ("instance name", "instancename")),
        "ip_address": any(x in lower for x in ("ip address", "ipaddresstype", "ipv4", "ipv6", "dualstack")),
        "key_pair": any(x in lower for x in ("key pair", "keypair", "keypairname")),
        "limit_or_quota": any(x in lower for x in ("limit", "quota", "maximum", "too many")),
        "region": "region" in lower,
        "tag": "tag" in lower,
        "unsupported": any(x in lower for x in ("unsupported", "not supported")),
        "user_data": any(x in lower for x in ("user data", "userdata", "launch script")),
    }

    sanitized = message
    sanitized = re.sub(r"arn:aws[a-zA-Z-]*:[^\s,;]+", "<ARN>", sanitized)
    sanitized = re.sub(r"\b\d{12}\b", "<ACCOUNT>", sanitized)
    sanitized = re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}(?:/\d{1,2})?\b", "<IP>", sanitized)
    sanitized = re.sub(r"[^@\s]+@[^@\s]+\.[^@\s]+", "<EMAIL>", sanitized)
    sanitized = sanitized.replace(INSTANCE_NAME, "<INSTANCE>")
    sanitized = sanitized.replace("quizforge-production-operator", "<KEY_PAIR>")
    sanitized = re.sub(r'"[^"\n]{1,160}"', '"<VALUE>"', sanitized)
    sanitized = re.sub(r"'[^'\n]{1,160}'", "'<VALUE>'", sanitized)
    sanitized = re.sub(r"\s+", " ", sanitized).strip()
    if len(sanitized) > 500:
        sanitized = sanitized[:500] + "…"

    return {
        "message_length": len(message),
        "mentions": mentions,
        "sanitized_message_template": sanitized,
    }


def request_shape(params: Mapping[str, Any]) -> dict[str, Any]:
    allowed = {
        "availabilityZone",
        "blueprintId",
        "bundleId",
        "instanceNames",
        "ipAddressType",
        "keyPairName",
        "tags",
        "userData",
        "addOns",
    }
    keys = {str(k) for k in params}
    return {
        "safe_present_parameter_names": sorted(keys & allowed),
        "unexpected_parameter_name_count": len(keys - allowed),
        "has_key_pair_name": isinstance(params.get("keyPairName"), str)
        and bool(params.get("keyPairName")),
        "key_pair_name_expected": params.get("keyPairName") == "quizforge-production-operator",
        "has_user_data": isinstance(params.get("userData"), str)
        and bool(params.get("userData")),
        "user_data_length": len(params.get("userData"))
        if isinstance(params.get("userData"), str) else 0,
        "ip_address_type": (
            params.get("ipAddressType")
            if params.get("ipAddressType") in {"ipv4", "ipv6", "dualstack"}
            else "unknown_or_absent"
        ),
        "has_add_ons": bool(params.get("addOns")),
    }


def parse_tags(params: Mapping[str, Any]) -> dict[str, Any]:
    raw = params.get("tags")
    pairs: dict[str, Any] = {}
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, Mapping):
                continue
            key = item.get("key")
            if isinstance(key, str):
                pairs[key] = item.get("value")
    elif isinstance(raw, Mapping):
        pairs = {str(k): v for k, v in raw.items()}

    keys = set(pairs)
    approved_keys = set(DEFAULT_TAGS)
    return {
        "default_tags_exact": all(pairs.get(k) == v for k, v in DEFAULT_TAGS.items())
        and approved_keys <= keys,
        "default_tag_key_count": len(keys & approved_keys),
        "purpose_tag_present": "Purpose" in keys,
        "safe_present_tag_keys": sorted(keys & {
            "Project", "Environment", "Temporary", "Purpose", "TestId", "DeleteAfter"
        }),
        "unexpected_tag_key_count": len(keys - {
            "Project", "Environment", "Temporary", "Purpose", "TestId", "DeleteAfter"
        }),
    }


def event_identity_matches(event: Mapping[str, Any], role_arn: str) -> bool:
    identity = event.get("userIdentity")
    if not isinstance(identity, Mapping):
        return False
    session = identity.get("sessionContext")
    if not isinstance(session, Mapping):
        return False
    issuer = session.get("sessionIssuer")
    return isinstance(issuer, Mapping) and issuer.get("arn") == role_arn


def cloudtrail_events(client, *, start: datetime, end: datetime, attribute_key: str, attribute_value: str) -> list[dict[str, Any]]:
    token = None
    result: list[dict[str, Any]] = []
    while True:
        args: dict[str, Any] = {
            "StartTime": start,
            "EndTime": end,
            "LookupAttributes": [{
                "AttributeKey": attribute_key,
                "AttributeValue": attribute_value,
            }],
            "MaxResults": 50,
        }
        if token:
            args["NextToken"] = token
        response = client.lookup_events(**args)
        result.extend(response.get("Events", []))
        token = response.get("NextToken")
        if not token:
            return result


def parse_cloudtrail_payload(wrapper: Mapping[str, Any]) -> dict[str, Any]:
    raw = wrapper.get("CloudTrailEvent")
    return json.loads(raw) if isinstance(raw, str) else {}


def incident_cloudtrail(cloudtrail, settings: Settings) -> dict[str, Any]:
    try:
        wrappers = cloudtrail_events(
            cloudtrail,
            start=INCIDENT_START,
            end=INCIDENT_END,
            attribute_key="EventSource",
            attribute_value="lightsail.amazonaws.com",
        )
    except ClientError as error:
        return {
            "available": False,
            "aws_error_code": safe_code(error.response.get("Error", {}).get("Code")),
        }

    events: list[dict[str, Any]] = []
    failures = 0
    for wrapper in wrappers:
        payload = parse_cloudtrail_payload(wrapper)
        name = payload.get("eventName")
        if name not in KNOWN_EVENT_NAMES:
            continue
        params = payload.get("requestParameters")
        params = params if isinstance(params, Mapping) else {}
        code = safe_code(payload.get("errorCode"), "NONE")
        message = str(payload.get("errorMessage") or "")
        failed = code != "NONE" or bool(message)
        if failed:
            failures += 1
        entry: dict[str, Any] = {
            "event_name": name,
            "failed": failed,
            "error_code": code,
            "failure_class": classify_error(code, message) if failed else "none",
            "configured_role_session": event_identity_matches(payload, settings.role),
        }
        if code == "InvalidInputException" and message:
            entry["invalid_input_detail"] = invalid_input_detail(message)
        denied = denied_action_from_message(message)
        if denied:
            entry["denied_action"] = denied
        if name == "CreateInstances":
            tags = parse_tags(params)
            entry.update({
                "availability_zone_expected": params.get("availabilityZone") == "ca-central-1a",
                "blueprint_expected": params.get("blueprintId") == BLUEPRINT,
                "bundle_expected": params.get("bundleId") == BUNDLE,
                "instance_count": len(params.get("instanceNames") or [])
                if isinstance(params.get("instanceNames"), list) else None,
                "requested_known_instance_name": (
                    params.get("instanceNames") == [INSTANCE_NAME]
                ),
                "request_shape": request_shape(params),
                "tags": tags,
            })
        events.append(entry)

    return {
        "available": True,
        "lightsail_event_count": len(events),
        "lightsail_failure_count": failures,
        "events": events,
    }


def recent_create_history(cloudtrail, settings: Settings) -> dict[str, Any]:
    try:
        wrappers = cloudtrail_events(
            cloudtrail,
            start=RECENT_START,
            end=INCIDENT_END,
            attribute_key="EventName",
            attribute_value="CreateInstances",
        )
    except ClientError as error:
        return {
            "available": False,
            "aws_error_code": safe_code(error.response.get("Error", {}).get("Code")),
        }

    stats = {
        "available": True,
        "event_count": 0,
        "success_count": 0,
        "failure_count": 0,
        "same_configured_role_success_count": 0,
        "success_with_purpose_tag_count": 0,
        "success_with_default_tags_count": 0,
        "success_with_key_pair_count": 0,
        "success_with_user_data_count": 0,
        "success_with_ipv4_count": 0,
        "success_with_dualstack_count": 0,
    }
    for wrapper in wrappers:
        payload = parse_cloudtrail_payload(wrapper)
        if payload.get("eventSource") != "lightsail.amazonaws.com":
            continue
        stats["event_count"] += 1
        failed = bool(payload.get("errorCode") or payload.get("errorMessage"))
        if failed:
            stats["failure_count"] += 1
            continue
        stats["success_count"] += 1
        if event_identity_matches(payload, settings.role):
            stats["same_configured_role_success_count"] += 1
        params = payload.get("requestParameters")
        params = params if isinstance(params, Mapping) else {}
        tags = parse_tags(params)
        shape = request_shape(params)
        if tags["purpose_tag_present"]:
            stats["success_with_purpose_tag_count"] += 1
        if tags["default_tags_exact"]:
            stats["success_with_default_tags_count"] += 1
        if shape["has_key_pair_name"]:
            stats["success_with_key_pair_count"] += 1
        if shape["has_user_data"]:
            stats["success_with_user_data_count"] += 1
        if shape["ip_address_type"] == "ipv4":
            stats["success_with_ipv4_count"] += 1
        if shape["ip_address_type"] == "dualstack":
            stats["success_with_dualstack_count"] += 1
    return stats


def lightsail_operations(client) -> dict[str, Any]:
    operations: list[dict[str, Any]] = []
    token = None
    try:
        while True:
            args = {"pageToken": token} if token else {}
            response = client.get_operations(**args)
            for item in response.get("operations", []):
                created = item.get("createdAt")
                if not isinstance(created, datetime):
                    continue
                created = created.astimezone(timezone.utc)
                if not (INCIDENT_START - timedelta(minutes=2) <= created <= INCIDENT_END + timedelta(minutes=2)):
                    continue
                resource_name = item.get("resourceName")
                details = str(item.get("errorDetails") or "")
                operations.append({
                    "operation_type": safe_code(item.get("operationType")),
                    "status": safe_code(item.get("status")),
                    "is_terminal": item.get("isTerminal") is True,
                    "error_code": safe_code(item.get("errorCode"), "NONE"),
                    "failure_class": classify_error(str(item.get("errorCode") or ""), details)
                    if item.get("errorCode") or details else "none",
                    "known_production_resource": resource_name == INSTANCE_NAME,
                    "resource_type": safe_code(item.get("resourceType")),
                })
            token = response.get("nextPageToken")
            if not token:
                break
    except ClientError as error:
        return {
            "available": False,
            "aws_error_code": safe_code(error.response.get("Error", {}).get("Code")),
        }

    return {
        "available": True,
        "matching_operation_count": len(operations),
        "operations": operations,
    }


def current_lightsail(client) -> dict[str, Any]:
    result: dict[str, Any] = {
        "instance_exists": False,
        "bundle_available": False,
        "blueprint_available": False,
        "key_pair_exists": False,
        "availability_zone_available": False,
    }
    try:
        try:
            client.get_instance(instanceName=INSTANCE_NAME)
            result["instance_exists"] = True
        except ClientError as error:
            code = safe_code(error.response.get("Error", {}).get("Code"))
            if code not in {"NotFoundException", "ResourceNotFoundException"}:
                result["instance_lookup_error_code"] = code

        try:
            client.get_key_pair(keyPairName="quizforge-production-operator")
            result["key_pair_exists"] = True
        except ClientError:
            pass

        regions = client.get_regions(includeAvailabilityZones=True).get("regions", [])
        result["availability_zone_available"] = any(
            zone.get("zoneName") == "ca-central-1a"
            for region in regions
            for zone in (region.get("availabilityZones") or [])
            if isinstance(zone, Mapping)
        )

        bundles = client.get_bundles(includeInactive=False).get("bundles", [])
        result["bundle_available"] = any(
            x.get("bundleId") == BUNDLE and x.get("isActive") is not False
            for x in bundles
        )
        blueprints = client.get_blueprints(includeInactive=False).get("blueprints", [])
        result["blueprint_available"] = any(
            x.get("blueprintId") == BLUEPRINT and x.get("isActive") is not False
            for x in blueprints
        )
    except ClientError as error:
        result["catalog_read_error_code"] = safe_code(error.response.get("Error", {}).get("Code"))
    return result


def simulation_context(default: bool, purpose: bool) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = [{
        "ContextKeyName": "aws:RequestedRegion",
        "ContextKeyValues": [REGION],
        "ContextKeyType": "string",
    }]
    keys: list[str] = []
    if default:
        for key, value in DEFAULT_TAGS.items():
            entries.append({
                "ContextKeyName": f"aws:RequestTag/{key}",
                "ContextKeyValues": [str(value)],
                "ContextKeyType": "string",
            })
            keys.append(key)
    if purpose:
        entries.extend([
            {
                "ContextKeyName": "aws:RequestTag/Purpose",
                "ContextKeyValues": ["quizforge-capacity-test"],
                "ContextKeyType": "string",
            },
            {
                "ContextKeyName": "aws:RequestTag/TestId",
                "ContextKeyValues": ["synthetic-diagnostic"],
                "ContextKeyType": "string",
            },
            {
                "ContextKeyName": "aws:RequestTag/DeleteAfter",
                "ContextKeyValues": ["synthetic-diagnostic"],
                "ContextKeyType": "string",
            },
        ])
        keys.extend(["Purpose", "TestId", "DeleteAfter"])
    entries.append({
        "ContextKeyName": "aws:TagKeys",
        "ContextKeyValues": keys,
        "ContextKeyType": "stringList",
    })
    return entries


def sanitize_missing_context(values: Iterable[Any]) -> list[str]:
    return sorted({
        str(value) for value in values
        if isinstance(value, str) and value in SAFE_CONTEXT_KEYS
    })


def simulate_create_instances(iam, settings: Settings) -> dict[str, Any]:
    result: dict[str, Any] = {"available": False}
    for label, default, purpose in (
        ("production_default_tags", True, False),
        ("capacity_test_tags", False, True),
    ):
        try:
            response = iam.simulate_principal_policy(
                PolicySourceArn=settings.role,
                ActionNames=["lightsail:CreateInstances"],
                ResourceArns=["*"],
                ContextEntries=simulation_context(default, purpose),
            )
            evaluation = (response.get("EvaluationResults") or [{}])[0]
            result["available"] = True
            result[label] = {
                "decision": safe_code(evaluation.get("EvalDecision")),
                "missing_context_keys": sanitize_missing_context(
                    evaluation.get("MissingContextValues") or []
                ),
            }
        except ClientError as error:
            result[label] = {
                "read_error_code": safe_code(error.response.get("Error", {}).get("Code")),
            }
    return result


def action_matches(pattern: str, action: str) -> bool:
    return fnmatch.fnmatchcase(action.lower(), pattern.lower())


def statement_actions(statement: Mapping[str, Any]) -> list[str]:
    raw = statement.get("Action")
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, str)]
    return []


def safe_condition_keys(statement: Mapping[str, Any]) -> list[str]:
    condition = statement.get("Condition")
    if not isinstance(condition, Mapping):
        return []
    found: set[str] = set()
    for values in condition.values():
        if not isinstance(values, Mapping):
            continue
        for key in values:
            if isinstance(key, str) and key in SAFE_CONDITION_KEYS:
                found.add(key)
    return sorted(found)


def policy_documents_for_role(iam, settings: Settings) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    meta: dict[str, Any] = {
        "available": True,
        "inline_policy_count": 0,
        "attached_policy_count": 0,
        "permissions_boundary_present": False,
    }
    role_name = settings.role.rsplit("/", 1)[-1]
    try:
        role = iam.get_role(RoleName=role_name)["Role"]
        boundary = role.get("PermissionsBoundary")
        meta["permissions_boundary_present"] = isinstance(boundary, Mapping)

        inline = iam.list_role_policies(RoleName=role_name).get("PolicyNames", [])
        meta["inline_policy_count"] = len(inline)
        for name in inline:
            doc = iam.get_role_policy(RoleName=role_name, PolicyName=name).get("PolicyDocument")
            if isinstance(doc, Mapping):
                documents.append(dict(doc))

        attached = iam.list_attached_role_policies(RoleName=role_name).get("AttachedPolicies", [])
        meta["attached_policy_count"] = len(attached)
        for item in attached:
            arn = item.get("PolicyArn")
            if not isinstance(arn, str):
                continue
            p = iam.get_policy(PolicyArn=arn).get("Policy", {})
            version_id = p.get("DefaultVersionId")
            if not isinstance(version_id, str):
                continue
            doc = iam.get_policy_version(PolicyArn=arn, VersionId=version_id).get(
                "PolicyVersion", {}
            ).get("Document")
            if isinstance(doc, Mapping):
                documents.append(dict(doc))

        if isinstance(boundary, Mapping):
            arn = boundary.get("PermissionsBoundaryArn")
            if isinstance(arn, str):
                p = iam.get_policy(PolicyArn=arn).get("Policy", {})
                version_id = p.get("DefaultVersionId")
                if isinstance(version_id, str):
                    doc = iam.get_policy_version(
                        PolicyArn=arn, VersionId=version_id
                    ).get("PolicyVersion", {}).get("Document")
                    if isinstance(doc, Mapping):
                        meta["permissions_boundary_statement_count"] = len(
                            doc.get("Statement", [])
                            if isinstance(doc.get("Statement"), list)
                            else [doc.get("Statement")]
                        )
    except ClientError as error:
        meta["available"] = False
        meta["aws_error_code"] = safe_code(error.response.get("Error", {}).get("Code"))
    return documents, meta


def summarize_role_policy(iam, settings: Settings) -> dict[str, Any]:
    documents, meta = policy_documents_for_role(iam, settings)
    summary: dict[str, Any] = dict(meta)
    for action in (
        "lightsail:CreateInstances",
        "lightsail:PutInstancePublicPorts",
        "lightsail:AttachStaticIp",
    ):
        allow = 0
        deny = 0
        conditional_allow = 0
        keys: set[str] = set()
        for document in documents:
            raw_statements = document.get("Statement", [])
            statements = raw_statements if isinstance(raw_statements, list) else [raw_statements]
            for statement in statements:
                if not isinstance(statement, Mapping):
                    continue
                patterns = statement_actions(statement)
                if not any(action_matches(pattern, action) for pattern in patterns):
                    continue
                effect = str(statement.get("Effect", "")).lower()
                if effect == "allow":
                    allow += 1
                    condition_keys = safe_condition_keys(statement)
                    if condition_keys:
                        conditional_allow += 1
                        keys.update(condition_keys)
                elif effect == "deny":
                    deny += 1
        summary[action] = {
            "allow_statement_count": allow,
            "conditional_allow_statement_count": conditional_allow,
            "deny_statement_count": deny,
            "safe_condition_keys": sorted(keys),
        }
    return summary


def main() -> int:
    settings: Settings | None = None
    report: dict[str, Any] = {
        "schema": 1,
        "operation": "lightsail_apply_failure_root_cause",
        "result": "diagnostic_failed",
        "changes_performed": False,
        "terraform_apply_attempted": False,
        "incident_window_utc": "2026-09-24T00:35:00Z/2026-09-24T00:37:30Z",
    }
    try:
        env = dict(os.environ)
        trusted(env)
        settings = Settings.from_env(env)
        check_source(Path.cwd())

        import boto3

        sts = boto3.client("sts", region_name=REGION)
        caller = sts.get_caller_identity()
        require(caller.get("Account") == settings.account, "ACCOUNT_MISMATCH")

        cloudtrail = boto3.client("cloudtrail", region_name=REGION)
        lightsail = boto3.client("lightsail", region_name=REGION)
        iam = boto3.client("iam", region_name=REGION)

        report.update({
            "cloudtrail_incident": incident_cloudtrail(cloudtrail, settings),
            "recent_create_instances_history": recent_create_history(cloudtrail, settings),
            "lightsail_operations": lightsail_operations(lightsail),
            "current_lightsail": current_lightsail(lightsail),
            "iam_simulation": simulate_create_instances(iam, settings),
            "deployment_role_policy_summary": summarize_role_policy(iam, settings),
            "result": "diagnostic_completed_no_changes",
        })
        write_report(report, settings)
        return 0
    except Refused as error:
        report["error_code"] = safe_code(str(error), "DIAGNOSTIC_REFUSED")
    except ClientError as error:
        report["error_code"] = "AWS_READ_FAILED"
        report["aws_error_code"] = safe_code(error.response.get("Error", {}).get("Code"))
    except Exception as error:
        report["error_code"] = "PRIVATE_DIAGNOSTIC_FAILED"
        report["exception_type"] = safe_code(type(error).__name__, "UnknownException")

    try:
        write_report(report, settings)
    except Exception:
        RESULT.unlink(missing_ok=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
