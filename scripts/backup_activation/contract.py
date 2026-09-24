"""Pure validation and reporting for the pinned, initial 13-create backup plan.

No AWS SDK, network, secrets, or subprocesses are used by this module.
Error codes are static: never interpolate a plan value into an exception.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Mapping

REPOSITORY = "HamedGithubforwork/QuizForge-AI"
WORKFLOW = ".github/workflows/aws-backup-activation.yml"
CANDIDATE = "62e39f33d715cc83928390cfd5ff1728008c4053"
MAIN_SHA256 = "c0edc4a089a6b4158f68ca1a8eef853910384d336a90fcb36ab77ccbc0140dc0"
TEST_SHA256 = "e703f3a10b0c785b0e2a1d88d87fa27d2aacbe17708326c6f622b209ef3d346c"
TERRAFORM = "1.14.7"
PROVIDER = "6.64.0"
REGION = "ca-central-1"
STATE_KEY = "quizforge/lightsail-backups/terraform.tfstate"
WORKSPACE_PREFIX = "quizforge/lightsail-backups/.disabled-workspaces"
CONFIRMATION = "ACTIVATE RETAINED BACKUPS ONLY"
TAGS = {"Project": "QuizForge", "Purpose": "production-backup"}
PROVIDER_NAME = "registry.terraform.io/hashicorp/aws"
BUCKET_ADDRESS = "aws_s3_bucket.backups"
TOPIC_ADDRESS = "aws_sns_topic.alerts"
OWNER_ADDRESS = "aws_sns_topic_subscription.owner"
ALARM_ADDRESS = "aws_cloudwatch_metric_alarm.backup"
ENCRYPTION_ADDRESS = "aws_s3_bucket_server_side_encryption_configuration.backups"
VERSIONING_ADDRESS = "aws_s3_bucket_versioning.backups"
POLICY_NAMES = {
    "uploader": "quizforge-production-backup-upload",
    "recovery": "quizforge-production-backup-recovery",
    "health": "quizforge-production-backup-health",
}


class Refused(RuntimeError):
    """A static public-safe code plus an optional reviewed-contract diagnostic."""

    def __init__(self, code: str, diagnostic_id: str = ""):
        super().__init__(code)
        self.code = code
        self.diagnostic_id = diagnostic_id


def require(condition: bool, code: str, diagnostic_id: str = "") -> None:
    if not condition:
        raise Refused(code, diagnostic_id)


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True, repr=False)
class Settings:
    role: str
    account: str
    state_bucket: str
    email: str

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Settings":
        role = env.get("QF_ROLE_ARN", "")
        match = re.fullmatch(r"arn:aws:iam::([0-9]{12}):role/[A-Za-z0-9+=,.@_/-]+", role)
        require(match is not None, "PRIVATE_ROLE_SETTING_INVALID")
        state = env.get("QF_STATE_BUCKET", "")
        require(bool(re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", state)),
                "PRIVATE_STATE_SETTING_INVALID")
        require(".." not in state and not re.fullmatch(r"[0-9.]+", state),
                "PRIVATE_STATE_SETTING_INVALID")
        email = env.get("AWS_BUDGET_ALERT_EMAIL", "")
        require(bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email))
                and len(email) <= 254 and all(32 <= ord(c) < 127 for c in email),
                "PRIVATE_RECIPIENT_SETTING_INVALID")
        assert match is not None
        account = match.group(1)
        require(state != f"quizforge-production-backups-{account}", "STATE_BACKUP_BUCKET_COLLISION")
        return cls(role, account, state, email)

    @property
    def bucket(self) -> str:
        return f"quizforge-production-backups-{self.account}"

    @property
    def bucket_arn(self) -> str:
        return f"arn:aws:s3:::{self.bucket}"

    @property
    def topic(self) -> str:
        return f"arn:aws:sns:{REGION}:{self.account}:quizforge-production-backup-alerts"

    @property
    def alarm(self) -> str:
        return f"arn:aws:cloudwatch:{REGION}:{self.account}:alarm:quizforge-production-backup-unhealthy"

    def policy_arn(self, name: str) -> str:
        require(name in POLICY_NAMES, "POLICY_NAME_INVALID")
        return f"arn:aws:iam::{self.account}:policy/{POLICY_NAMES[name]}"


def trusted_invocation(env: Mapping[str, str], mode: str) -> None:
    require(mode in {"inspect", "activate", "verify"}, "MODE_INVALID")
    event = env.get("GITHUB_EVENT_NAME")
    push_inspect = event == "push" and mode == "inspect"
    manual = event == "workflow_dispatch"
    require((manual or push_inspect)
            and env.get("GITHUB_REF") == "refs/heads/main"
            and env.get("GITHUB_REPOSITORY") == REPOSITORY
            and env.get("GITHUB_WORKFLOW_REF") == f"{REPOSITORY}/{WORKFLOW}@refs/heads/main",
            "UNTRUSTED_INVOCATION")
    sha = env.get("GITHUB_SHA", "")
    require(bool(re.fullmatch(r"[0-9a-f]{40}", sha))
            and env.get("GITHUB_WORKFLOW_SHA") == sha, "UNTRUSTED_WORKFLOW_REVISION")
    require(env.get("TF_WORKSPACE", "default") == "default", "NONDEFAULT_WORKSPACE")
    if event == "push":
        require(mode == "inspect"
                and not env.get("QF_REVIEWED_MANIFEST")
                and not env.get("QF_CONFIRMATION"),
                "PUSH_MAY_ONLY_INSPECT")
    if mode == "activate":
        require(event == "workflow_dispatch", "ACTIVATION_MUST_BE_MANUAL")
        require(env.get("GITHUB_RUN_ATTEMPT") == "1", "ACTIVATION_RERUN_REFUSED")
        require(env.get("QF_CONFIRMATION") == CONFIRMATION, "ACTIVATION_CONFIRMATION_REQUIRED")
        require(bool(re.fullmatch(r"[0-9a-f]{64}", env.get("QF_REVIEWED_MANIFEST", ""))),
                "REVIEWED_MANIFEST_REQUIRED")
    if mode == "verify":
        require(event == "workflow_dispatch", "VERIFY_MUST_BE_MANUAL")
    require(not env.get("ACTIONS_STEP_DEBUG") and not env.get("RUNNER_DEBUG"), "DEBUG_MODE_REFUSED")


def policy_documents(account: str) -> dict[str, Any]:
    bucket = f"arn:aws:s3:::quizforge-production-backups-{account}"
    objects = [f"{bucket}/lightsail/*", f"{bucket}/receipts/*"]
    metric = {"Effect": "Allow", "Action": ["cloudwatch:PutMetricData"], "Resource": "*",
              "Condition": {"StringEquals": {"cloudwatch:namespace": "QuizForge/Backup"}}}
    return {
        "bucket": {"Version": "2012-10-17", "Statement": [
            {"Sid": "RequireTLS", "Effect": "Deny", "Principal": "*", "Action": "s3:*",
             "Resource": [bucket, f"{bucket}/*"],
             "Condition": {"Bool": {"aws:SecureTransport": "false"}}},
            {"Sid": "RequireEncryption", "Effect": "Deny", "Principal": "*", "Action": "s3:PutObject",
             "Resource": f"{bucket}/*",
             "Condition": {"StringNotEquals": {"s3:x-amz-server-side-encryption": "AES256"}}},
            {"Sid": "RequireConditionalCreate", "Effect": "Deny", "Principal": "*", "Action": "s3:PutObject",
             "Resource": f"{bucket}/*", "Condition": {"StringNotEquals": {"s3:if-none-match": "*"}}},
        ]},
        "uploader": {"Version": "2012-10-17", "Statement": [
            {"Effect": "Allow", "Action": ["s3:GetBucketVersioning"], "Resource": bucket},
            {"Effect": "Allow", "Action": ["s3:PutObject"], "Resource": objects}, metric]},
        "recovery": {"Version": "2012-10-17", "Statement": [
            {"Effect": "Allow", "Action": ["s3:ListBucketVersions"], "Resource": bucket,
             "Condition": {"StringLike": {"s3:prefix": "receipts/*"}}},
            {"Effect": "Allow", "Action": ["s3:GetObjectVersion"], "Resource": objects}]},
        "health": {"Version": "2012-10-17", "Statement": [metric]},
    }


def expected_values(account: str, email: str) -> dict[str, Any]:
    bucket = f"quizforge-production-backups-{account}"
    topic = f"arn:aws:sns:{REGION}:{account}:quizforge-production-backup-alerts"
    policies = policy_documents(account)
    result = {
        BUCKET_ADDRESS: {"bucket": bucket, "force_destroy": False, "tags": TAGS},
        "aws_s3_bucket_public_access_block.backups": {
            "bucket": bucket, "block_public_acls": True, "block_public_policy": True,
            "ignore_public_acls": True, "restrict_public_buckets": True},
        "aws_s3_bucket_ownership_controls.backups": {
            "bucket": bucket, "rule": [{"object_ownership": "BucketOwnerEnforced"}]},
        "aws_s3_bucket_versioning.backups": {
            "bucket": bucket, "versioning_configuration": [{"status": "Enabled"}]},
        "aws_s3_bucket_server_side_encryption_configuration.backups": {
            "bucket": bucket, "rule": [{"apply_server_side_encryption_by_default": [{"sse_algorithm": "AES256"}]}]},
        "aws_s3_bucket_lifecycle_configuration.backups": {
            "bucket": bucket, "rule": [
                {"id": "bounded-recovery-window", "status": "Enabled", "filter": [{}],
                 "expiration": [{"days": 7}], "noncurrent_version_expiration": [{"noncurrent_days": 7}],
                 "abort_incomplete_multipart_upload": [{"days_after_initiation": 1}]},
                {"id": "remove-expired-markers", "status": "Enabled", "filter": [{}],
                 "expiration": [{"expired_object_delete_marker": True}]},
            ]},
        "aws_s3_bucket_policy.backups": {"bucket": bucket, "policy": canonical(policies["bucket"])},
        TOPIC_ADDRESS: {"name": "quizforge-production-backup-alerts", "tags": TAGS},
        OWNER_ADDRESS: {"topic_arn": topic, "protocol": "email", "endpoint": email},
        ALARM_ADDRESS: {
            "alarm_name": "quizforge-production-backup-unhealthy",
            "alarm_description": "Failed backup, no valid snapshot within 26 hours, or missing hourly host heartbeat.",
            "namespace": "QuizForge/Backup", "metric_name": "BackupFresh",
            "dimensions": {"Deployment": "production-lightsail"},
            "comparison_operator": "LessThanThreshold", "threshold": 1,
            "period": 3600, "evaluation_periods": 1, "datapoints_to_alarm": 1,
            "statistic": "Minimum", "treat_missing_data": "breaching",
            "actions_enabled": True, "alarm_actions": [topic], "ok_actions": [topic], "tags": TAGS},
    }
    for name, policy_name in POLICY_NAMES.items():
        result[f"aws_iam_policy.{name}"] = {
            "name": policy_name, "path": "/", "tags": TAGS, "policy": canonical(policies[name])}
    return copy.deepcopy(result)


EXPECTED = frozenset(expected_values("ACCOUNT", "RECIPIENT"))


def unknown(value: Any) -> bool:
    if isinstance(value, dict):
        return any(unknown(v) for v in value.values())
    if isinstance(value, list):
        return any(unknown(v) for v in value)
    return value is True


def policy_canonical(value: Any) -> Any:
    """Order-independent JSON, accepting AWS singleton/list policy equivalence."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            raise Refused("POLICY_JSON_INVALID") from None
    def normalize(item: Any, key: str = "") -> Any:
        if key in {"Action", "NotAction", "Resource", "NotResource", "Statement"} and not isinstance(item, list):
            item = [item]
        if isinstance(item, dict):
            return {k: normalize(v, k) for k, v in item.items()}
        if isinstance(item, list):
            return sorted((normalize(v) for v in item), key=canonical)
        return item
    return normalize(value)


def compare(actual: Any, expected: Any, mask: Any = None, key: str = "", path: str = "") -> None:
    """Compare only reviewed fields and attach a non-sensitive contract path on refusal."""
    here = path or key
    require(mask is not True, "UNKNOWN_SAFETY_FIELD", here)
    if key in {"rule", "filter", "versioning_configuration", "expiration",
               "noncurrent_version_expiration", "apply_server_side_encryption_by_default"}:
        require(not unknown(mask), "UNKNOWN_SAFETY_FIELD", here)
    if key == "policy":
        require(not unknown(mask), "UNKNOWN_SAFETY_FIELD", here)
        require(policy_canonical(actual) == policy_canonical(expected), "UNSAFE_POLICY", here)
    elif isinstance(expected, dict):
        require(isinstance(actual, dict), "SAFETY_FIELD_MISSING", here)
        for name, value in expected.items():
            child = f"{here}.{name}" if here else name
            require(name in actual, "SAFETY_FIELD_MISSING", child)
            compare(actual[name], value, mask.get(name) if isinstance(mask, dict) else None,
                    name, child)
        if key in {"tags", "tags_all", "dimensions"}:
            require(actual == expected, "UNEXPECTED_TAGS_OR_DIMENSIONS", here)
    elif isinstance(expected, list):
        require(isinstance(actual, list) and len(actual) == len(expected),
                "SAFETY_LIST_MISMATCH", here)
        for index, value in enumerate(expected):
            child = f"{here}[{index}]"
            compare(actual[index], value,
                    mask[index] if isinstance(mask, list) and index < len(mask) else None,
                    key, child)
    else:
        require(not unknown(mask), "UNKNOWN_SAFETY_FIELD", here)
        # Terraform numbers may be rendered as integer or float, but never bool.
        same_type = type(actual) is type(expected)
        if type(expected) in {int, float}:
            same_type = type(actual) in {int, float}
        require(same_type and actual == expected, "SAFETY_VALUE_MISMATCH", here)


def resolve_named_links(address: str, values: dict, mask: dict, expression: dict,
                        expected: dict) -> None:
    """Resolve only links proven by the immutable source and exact plan references.

    Do not infer an unknown bool, number, recipient, policy, or arbitrary ARN.
    Terraform normally defers IDs/ARNs for resources being created. These four
    link shapes are provable from the known bucket/topic name and verified account.
    The caller MUST have authenticated the exact candidate and main.tf bytes.
    """
    links: dict[str, str] = {}
    if address.startswith("aws_s3_bucket_"):
        links["bucket"] = "aws_s3_bucket.backups.id"
    if address == OWNER_ADDRESS:
        links["topic_arn"] = "aws_sns_topic.alerts.arn"
    if address == ALARM_ADDRESS:
        links.update(alarm_actions="aws_sns_topic.alerts.arn", ok_actions="aws_sns_topic.alerts.arn")
    for field, reference in links.items():
        if not unknown(mask.get(field)):
            continue
        expr = expression.get(field, {})
        refs = expr.get("references", [])
        allowed = {reference, reference.rsplit(".", 1)[0]}
        require(set(expr) == {"references"} and isinstance(refs, list)
                and reference in refs and set(refs) <= allowed, "UNPROVEN_RESOURCE_LINK")
        # A partially known list must not smuggle a second/wrong destination.
        current = values.get(field)
        if isinstance(expected[field], list):
            require(current in (None, [None], expected[field]), "RESOURCE_LINK_MISMATCH")
            require(mask.get(field) in (True, [True]), "UNPROVEN_RESOURCE_LINK")
        else:
            require(current in (None, expected[field]), "RESOURCE_LINK_MISMATCH")
            require(mask.get(field) is True, "UNPROVEN_RESOURCE_LINK")
        values[field] = copy.deepcopy(expected[field])
        mask.pop(field, None)


def resolve_pinned_encryption_rule(address: str, values: dict, mask: dict,
                                   expected: dict) -> None:
    """Resolve only the provider-computed S3 encryption set around pinned AES256.

    AWS provider 6.64.0 models `rule` as a required set whose element also contains
    Optional+Computed fields. Because those computed values participate in set
    identity, Terraform may mark the whole set unknown even though the immutable
    source fixes `sse_algorithm = "AES256"`.

    The exact candidate/main.tf hash is checked before live review. This exception
    therefore accepts only that source-proven AES256 rule and refuses any
    materialized KMS key, blocked encryption type, bucket key enablement, wrong
    algorithm, extra rule, or unexpected field.
    """
    if address != ENCRYPTION_ADDRESS or not unknown(mask.get("rule")):
        return

    current = values.get("rule")
    if current not in (None, []):
        require(isinstance(current, list) and len(current) == 1,
                "UNPROVEN_ENCRYPTION_RULE", f"{address}.rule")
        rule = current[0]
        require(isinstance(rule, dict)
                and set(rule) <= {
                    "apply_server_side_encryption_by_default",
                    "blocked_encryption_types",
                    "bucket_key_enabled",
                },
                "UNPROVEN_ENCRYPTION_RULE", f"{address}.rule")

        apply_default = rule.get("apply_server_side_encryption_by_default")
        if apply_default not in (None, []):
            require(isinstance(apply_default, list) and len(apply_default) == 1
                    and isinstance(apply_default[0], dict),
                    "UNPROVEN_ENCRYPTION_RULE",
                    f"{address}.rule.apply_server_side_encryption_by_default")
            encryption = apply_default[0]
            require(set(encryption) <= {"sse_algorithm", "kms_master_key_id"},
                    "UNPROVEN_ENCRYPTION_RULE",
                    f"{address}.rule.apply_server_side_encryption_by_default")
            algorithm = encryption.get("sse_algorithm")
            require(algorithm in (None, "AES256"), "UNEXPECTED_ENCRYPTION_SETTING",
                    f"{address}.rule.apply_server_side_encryption_by_default.sse_algorithm")
            require(encryption.get("kms_master_key_id") in (None, ""),
                    "UNEXPECTED_ENCRYPTION_SETTING",
                    f"{address}.rule.apply_server_side_encryption_by_default.kms_master_key_id")

        require(rule.get("blocked_encryption_types") in (None, []),
                "UNEXPECTED_ENCRYPTION_SETTING",
                f"{address}.rule.blocked_encryption_types")
        require(rule.get("bucket_key_enabled") in (None, False),
                "UNEXPECTED_ENCRYPTION_SETTING",
                f"{address}.rule.bucket_key_enabled")

    values["rule"] = copy.deepcopy(expected["rule"])
    mask.pop("rule", None)


def resolve_pinned_versioning_block(address: str, values: dict, mask: dict,
                                    expected: dict) -> None:
    """Resolve only the provider-computed versioning block around pinned Enabled.

    AWS provider 6.64.0 models `versioning_configuration` as a required one-item
    list whose `status` is required and whose `mfa_delete` is Optional+Computed.
    Terraform may therefore mark the whole block unknown even though the immutable
    source fixes `status = "Enabled"`.

    The exact candidate/main.tf hash is checked before live review. This exception
    accepts only that source-proven Enabled state and refuses Suspended/Disabled
    status, MFA-delete enablement, multiple blocks, or unexpected fields.
    """
    field = "versioning_configuration"
    if address != VERSIONING_ADDRESS or not unknown(mask.get(field)):
        return

    current = values.get(field)
    if current not in (None, []):
        require(isinstance(current, list) and len(current) == 1,
                "UNPROVEN_VERSIONING_CONFIGURATION", f"{address}.{field}")
        item = current[0]
        require(isinstance(item, dict) and set(item) <= {"status", "mfa_delete"},
                "UNPROVEN_VERSIONING_CONFIGURATION", f"{address}.{field}")
        require(item.get("status") in (None, "Enabled"),
                "UNEXPECTED_VERSIONING_SETTING", f"{address}.{field}.status")
        require(item.get("mfa_delete") in (None, "", "Disabled"),
                "UNEXPECTED_MFA_DELETE", f"{address}.{field}.mfa_delete")

    values[field] = copy.deepcopy(expected[field])
    mask.pop(field, None)


# The pinned AWS provider 6.64.0 marks these omitted fields Optional+Computed.
# Their source configuration is immutable and mutually exclusive explicit fields
# (bucket/name) are already fixed. A live plan may therefore leave only these
# provider-derived defaults unknown. This allowlist must not grow without checking
# the exact pinned provider schema and create behavior.
UNKNOWN_OPTIONAL_DEFAULTS = {
    BUCKET_ADDRESS: frozenset({
        "acl", "object_lock_enabled", "bucket_prefix", "grant",
        "replication_configuration", "website",
    }),
    ALARM_ADDRESS: frozenset({"evaluate_low_sample_count_percentiles"}),
    TOPIC_ADDRESS: frozenset({"name_prefix"}),
}


def no_extra_settings(address: str, values: dict, mask: dict) -> None:
    """Reject non-default dangerous options not requested by the pinned source."""
    defaults: dict[str, tuple] = {}
    if address == BUCKET_ADDRESS:
        defaults = {"acl": (None, "private"), "object_lock_enabled": (None, False),
                    "bucket_prefix": (None, ""), "grant": (None, []),
                    "replication_configuration": (None, []), "website": (None, [])}
    elif address == ALARM_ADDRESS:
        defaults = {"insufficient_data_actions": (None, []), "metric_query": (None, []),
                    "extended_statistic": (None, ""), "threshold_metric_id": (None, ""),
                    "unit": (None, ""), "evaluate_low_sample_count_percentiles": (None, "")}
    elif address == TOPIC_ADDRESS:
        defaults = {"fifo_topic": (None, False), "name_prefix": (None, ""),
                    "kms_master_key_id": (None, ""), "delivery_policy": (None, ""),
                    "application_success_feedback_role_arn": (None, ""),
                    "http_success_feedback_role_arn": (None, ""),
                    "lambda_success_feedback_role_arn": (None, ""),
                    "sqs_success_feedback_role_arn": (None, ""),
                    "application_failure_feedback_role_arn": (None, ""),
                    "http_failure_feedback_role_arn": (None, ""),
                    "lambda_failure_feedback_role_arn": (None, ""),
                    "sqs_failure_feedback_role_arn": (None, ""),
                    "firehose_success_feedback_role_arn": (None, ""),
                    "firehose_failure_feedback_role_arn": (None, "")}
        # A service-generated default policy can be unknown; a configured topic
        # policy expression is separately prohibited by the source hash.
    elif address == OWNER_ADDRESS:
        defaults = {"filter_policy": (None, "", "{}"), "redrive_policy": (None, "", "{}"),
                    "raw_message_delivery": (None, False), "subscription_role_arn": (None, ""),
                    "delivery_policy": (None, "", "{}"), "replay_policy": (None, "", "{}")}
    unknown_allowed = UNKNOWN_OPTIONAL_DEFAULTS.get(address, frozenset())
    for key, allowed in defaults.items():
        if unknown(mask.get(key)):
            require(key in unknown_allowed, "UNKNOWN_OPTIONAL_SAFETY_FIELD",
                    f"{address}.{key}")
            # Terraform normally renders an unknown omitted optional as null/empty.
            # Refuse any simultaneously materialized unsafe value even when masked.
            require(values.get(key) in allowed, "UNKNOWN_OPTIONAL_PLACEHOLDER_UNSAFE",
                    f"{address}.{key}")
            continue
        require(values.get(key) in allowed, "UNEXPECTED_RESOURCE_SETTING")
    if "region" in values:
        require(values["region"] == REGION and not unknown(mask.get("region")), "WRONG_REGION")
    if "tags_all" in values:
        compare(values["tags_all"], TAGS, mask.get("tags_all"), "tags_all",
                f"{address}.tags_all")


def review_plan(plan: dict, settings: Settings) -> dict:
    require(isinstance(plan, dict) and plan.get("format_version") == "1.2", "PLAN_FORMAT_UNSUPPORTED")
    require(plan.get("terraform_version") == TERRAFORM, "TERRAFORM_VERSION_MISMATCH")
    require(plan.get("errored") is False and plan.get("applyable") is True
            and plan.get("complete") is True, "INCOMPLETE_OR_ERRORED_PLAN")
    require(not plan.get("deferred_changes") and not plan.get("resource_drift")
            and not plan.get("action_invocations"), "UNEXPECTED_PLAN_SIDE_EFFECTS")
    for check in plan.get("checks", []):
        require(check.get("status") == "pass", "PLAN_CHECK_NOT_PASSED")
    previous = plan.get("prior_state", {}).get("values", {}).get("root_module", {})
    require(not previous.get("child_modules") and not any(
        r.get("mode") == "managed" for r in previous.get("resources", [])), "INITIAL_STATE_NOT_EMPTY")
    require(plan.get("variables", {}).get("alert_email", {}).get("value") == settings.email,
            "PLAN_RECIPIENT_MISMATCH")
    root = plan.get("configuration", {}).get("root_module", {})
    require(not root.get("module_calls"), "NESTED_CONFIGURATION_REFUSED")
    configurations = root.get("resources", [])
    require(isinstance(configurations, list), "CONFIGURATION_MISSING")
    configs = {r.get("address"): r for r in configurations}
    require(len(configs) == len(configurations), "DUPLICATE_CONFIGURATION")
    require({r.get("address") for r in configurations if r.get("mode") == "managed"} == EXPECTED,
            "CONFIGURATION_RESOURCE_MISMATCH")
    for r in configurations:
        require(r.get("mode") in {"managed", "data"}, "RESOURCE_MODE_INVALID")
        if r.get("mode") == "data":
            require(r.get("address") == "data.aws_caller_identity.current", "UNEXPECTED_DATA_SOURCE")
    changes = plan.get("resource_changes", [])
    require(isinstance(changes, list), "RESOURCE_CHANGES_MISSING")
    managed = [r for r in changes if r.get("mode") == "managed"]
    require(len(managed) == 13 and {r.get("address") for r in managed} == EXPECTED,
            "EXPECTED_13_RESOURCES")
    for r in changes:
        require(r.get("mode") in {"managed", "data"}, "RESOURCE_MODE_INVALID")
        if r.get("mode") == "data":
            require(r.get("address") == "data.aws_caller_identity.current"
                    and r.get("change", {}).get("actions") in (["read"], ["no-op"]),
                    "UNEXPECTED_DATA_SOURCE")
    expected = expected_values(settings.account, settings.email)
    for r in managed:
        address = r["address"]
        require(r.get("type") == address.split(".")[0] and r.get("provider_name") == PROVIDER_NAME,
                "UNEXPECTED_RESOURCE_PROVIDER")
        change = r.get("change", {})
        require(change.get("actions") == ["create"] and change.get("before") is None,
                "INITIAL_CREATES_ONLY")
        require(not change.get("replace_paths") and not change.get("importing")
                and not r.get("previous_address") and not r.get("deposed"), "ADOPTION_OR_REPLACEMENT_REFUSED")
        values, mask = copy.deepcopy(change.get("after")), copy.deepcopy(change.get("after_unknown", {}))
        require(isinstance(values, dict) and isinstance(mask, dict), "RESOURCE_VALUES_MISSING")
        resolve_named_links(address, values, mask, configs[address].get("expressions", {}), expected[address])
        resolve_pinned_encryption_rule(address, values, mask, expected[address])
        resolve_pinned_versioning_block(address, values, mask, expected[address])
        no_extra_settings(address, values, mask)
        compare(values, expected[address], mask, path=address)
        if address == "aws_s3_bucket_versioning.backups":
            require(values["versioning_configuration"][0].get("mfa_delete") in (None, "", "Disabled"),
                    "UNEXPECTED_MFA_DELETE")
        if address == "aws_s3_bucket_server_side_encryption_configuration.backups":
            rule = values["rule"][0]
            encryption = rule["apply_server_side_encryption_by_default"][0]
            require(encryption.get("kms_master_key_id") in (None, "")
                    and rule.get("bucket_key_enabled") in (None, False), "UNEXPECTED_ENCRYPTION_SETTING")
        if address == "aws_s3_bucket_lifecycle_configuration.backups":
            for index, rule in enumerate(values["rule"]):
                require(not rule.get("transition") and not rule.get("noncurrent_version_transition"),
                        "UNEXPECTED_LIFECYCLE_TRANSITION")
                require(rule.get("prefix") in (None, ""), "UNEXPECTED_LIFECYCLE_FILTER")
                for filt in rule.get("filter", []):
                    require(not any(v not in (None, "", [], {}) for v in filt.values()),
                            "UNEXPECTED_LIFECYCLE_FILTER")
                expiration = rule["expiration"][0]
                require(expiration.get("date") in (None, ""), "UNEXPECTED_EXPIRATION_DATE")
                if index == 0:
                    require(expiration.get("expired_object_delete_marker") in (None, False),
                            "UNEXPECTED_MARKER_EXPIRATION")
                    require(rule["noncurrent_version_expiration"][0].get("newer_noncurrent_versions") in (None, 0),
                            "UNEXPECTED_NONCURRENT_VERSION_LIMIT")
                else:
                    require(expiration.get("days") in (None, 0)
                            and not rule.get("noncurrent_version_expiration")
                            and not rule.get("abort_incomplete_multipart_upload"), "UNEXPECTED_MARKER_RULE")
    # The public manifest is constructed exclusively from reviewed constants.
    # It is NOT a hash of private state, email, role, or raw plan content.
    return {
        "schema": 1, "configuration_sha": CANDIDATE, "main_tf_sha256": MAIN_SHA256,
        "terraform_version": TERRAFORM, "aws_provider_version": PROVIDER, "region": REGION,
        "state_key": STATE_KEY, "workspace": "default", "creates": 13, "updates": 0, "deletes": 0,
        "private_recipient_matches_current_secret": True,
        "resource_contract": expected_values("APPROVED_ACCOUNT", "APPROVED_PRIVATE_RECIPIENT"),
        "policy_attachments_requested": 0, "production_routing_changes_requested": False,
        "scheduled_backup_installation_requested": False,
    }


def new_report(mode: str) -> dict:
    return {"schema": 1, "operation": mode if mode in {"inspect", "activate", "verify"} else "invalid",
            "configuration_sha": CANDIDATE, "state_key": STATE_KEY, "result": "not_started",
            "apply_attempted": False, "terraform_apply_completed": False,
            "infrastructure_settings_verified": False, "subscription_state": "unverified",
            "email_delivery_verified": False, "actual_aws_restore_tested": False,
            "scheduled_backups_verified": False, "independent_keys_verified": False,
            "separate_uploader_recovery_identities_verified": False,
            "failure_stale_missing_heartbeat_delivery_verified": False,
            "production_routing_changes_requested": False, "policy_attachments_requested": 0,
            "diagnostic_id": ""}


def error_result(report: dict) -> None:
    report["infrastructure_settings_verified"] = False
    if report["terraform_apply_completed"]:
        report["result"] = "apply_completed_readback_not_verified"
    elif report["apply_attempted"]:
        report["result"] = "apply_failed_possible_partial_resources"
    else:
        report["result"] = "blocked_no_apply_attempted"
