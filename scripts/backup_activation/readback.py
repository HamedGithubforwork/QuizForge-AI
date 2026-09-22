"""Exact-resource collision checks and read-only post-activation verification."""
from __future__ import annotations

import json
import re
from urllib.parse import unquote

from .contract import (REGION, STATE_KEY, TAGS, POLICY_NAMES, ALARM_ADDRESS,
                       Settings, Refused, compare, expected_values, policy_documents,
                       policy_canonical, require)


def absent(call, codes: set[str]) -> None:
    """Only explicit service not-found responses prove absence; 403 never does."""
    try:
        call()
    except Exception as error:
        response = getattr(error, "response", {})
        code = response.get("Error", {}).get("Code") if isinstance(response, dict) else None
        if code in codes:
            return
        raise
    raise Refused("NAMED_RESOURCE_COLLISION")


def inventory(sessions, settings: Settings) -> None:
    s3, sns, iam, cw = (sessions.client(s) for s in ("s3", "sns", "iam", "cloudwatch"))
    absent(lambda: s3.get_bucket_versioning(Bucket=settings.bucket, ExpectedBucketOwner=settings.account),
           {"NoSuchBucket"})
    absent(lambda: sns.get_topic_attributes(TopicArn=settings.topic), {"NotFound", "NotFoundException"})
    for name in POLICY_NAMES:
        absent(lambda name=name: iam.get_policy(PolicyArn=settings.policy_arn(name)), {"NoSuchEntity"})
    # ListTagsForResource is scoped to the exact alarm ARN and detects a name
    # collision regardless of whether an existing alarm is metric or composite.
    # Do NOT broaden DescribeAlarms to Resource='*' to inspect composite alarms.
    absent(lambda: cw.list_tags_for_resource(ResourceARN=settings.alarm),
           {"ResourceNotFound", "ResourceNotFoundException"})


def empty_state(sessions, settings: Settings) -> None:
    s3 = sessions.client("s3", "qf-state")
    common = {"Bucket": settings.state_bucket, "ExpectedBucketOwner": settings.account}
    require(s3.get_bucket_versioning(**common).get("Status") == "Enabled", "STATE_VERSIONING_REQUIRED")
    require(s3.get_bucket_location(**common).get("LocationConstraint") == REGION, "STATE_REGION_MISMATCH")
    try:
        result = s3.get_object(**common, Key=STATE_KEY)
    except Exception as error:
        response = getattr(error, "response", {})
        if isinstance(response, dict) and response.get("Error", {}).get("Code") == "NoSuchKey":
            return
        raise
    body = result["Body"]
    try:
        raw = body.read(8 * 1024 * 1024 + 1)
    finally:
        body.close()
    require(len(raw) <= 8 * 1024 * 1024, "STATE_TOO_LARGE")
    state = json.loads(raw)
    require(state.get("version") == 4 and not state.get("resources") and not state.get("outputs"),
            "INITIAL_STATE_NOT_EMPTY")


def tags(items: list[dict]) -> dict:
    require(isinstance(items, list), "TAGS_INVALID")
    result = {item["Key"]: item["Value"] for item in items}
    require(len(result) == len(items) and result == TAGS, "TAGS_MISMATCH")
    return result


def parse_iam_document(value):
    if isinstance(value, dict):
        return value
    require(isinstance(value, str), "POLICY_JSON_INVALID")
    try:
        return json.loads(value)
    except ValueError:
        try:
            return json.loads(unquote(value))
        except ValueError:
            raise Refused("POLICY_JSON_INVALID") from None


def verify_topic_policy(value: str, settings: Settings) -> None:
    """Accept only an owner-constrained AWS default topic policy, never new grants.

    The pinned topic has no custom policy. Delivery by CloudWatch is NOT inferred
    from this policy check; it requires the separate end-to-end alert gate.
    """
    policy = json.loads(value)
    require(policy.get("Version") in {"2008-10-17", "2012-10-17"}, "TOPIC_POLICY_VERSION_INVALID")
    require(set(policy) <= {"Version", "Id", "Statement"}, "UNEXPECTED_TOPIC_POLICY")
    statements = policy.get("Statement")
    require(isinstance(statements, list) and len(statements) == 1, "UNEXPECTED_TOPIC_POLICY")
    statement = statements[0]
    require(set(statement) <= {"Sid", "Effect", "Principal", "Action", "Resource", "Condition"},
            "UNEXPECTED_TOPIC_POLICY")
    require(statement.get("Effect") == "Allow" and statement.get("Resource") == settings.topic
            and statement.get("Principal") in ({"AWS": "*"}, {"AWS": ["*"]}), "UNSAFE_TOPIC_POLICY")
    condition = statement.get("Condition", {})
    require(set(condition) == {"StringEquals"}, "UNSAFE_TOPIC_POLICY")
    equals = condition["StringEquals"]
    require(isinstance(equals, dict) and len(equals) == 1
            and {k.lower(): v for k, v in equals.items()} == {"aws:sourceowner": settings.account},
            "UNSAFE_TOPIC_POLICY")
    actions = statement.get("Action", [])
    require(isinstance(actions, list) and all(isinstance(a, str) for a in actions), "UNSAFE_TOPIC_POLICY")
    normalized = {a.lower() for a in actions}
    permitted = {"sns:gettopicattributes", "sns:settopicattributes", "sns:addpermission", "sns:removepermission",
                 "sns:deletetopic", "sns:subscribe", "sns:listsubscriptionsbytopic", "sns:publish", "sns:receive"}
    require(len(normalized) == len(actions) and normalized <= permitted
            and {"sns:publish", "sns:subscribe", "sns:gettopicattributes"} <= normalized,
            "UNSAFE_TOPIC_POLICY")


def subscription_state(sns, settings: Settings) -> str:
    subscriptions = []
    request = {"TopicArn": settings.topic}
    for _ in range(10):
        result = sns.list_subscriptions_by_topic(**request)
        subscriptions.extend(result.get("Subscriptions", []))
        require(len(subscriptions) <= 1, "UNEXPECTED_SUBSCRIBER")
        token = result.get("NextToken")
        if not token:
            break
        request["NextToken"] = token
    else:
        raise Refused("SUBSCRIPTION_PAGINATION_LIMIT")
    require(len(subscriptions) == 1, "EXPECTED_ONE_SUBSCRIBER")
    sub = subscriptions[0]
    require(sub.get("TopicArn") == settings.topic and sub.get("Protocol") == "email"
            and sub.get("Endpoint") == settings.email and sub.get("Owner") == settings.account,
            "SUBSCRIBER_MISMATCH")
    arn = sub.get("SubscriptionArn", "")
    if arn == "PendingConfirmation":
        return "pending"
    require(isinstance(arn, str) and re.fullmatch(re.escape(settings.topic) +
            r":[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", arn) is not None,
            "SUBSCRIPTION_ARN_MISMATCH")
    attributes = sns.get_subscription_attributes(SubscriptionArn=arn)["Attributes"]
    require(attributes.get("TopicArn") == settings.topic and attributes.get("Protocol") == "email"
            and attributes.get("Endpoint") == settings.email and attributes.get("Owner") == settings.account,
            "SUBSCRIBER_MISMATCH")
    require(not attributes.get("FilterPolicy") or attributes["FilterPolicy"] == "{}", "SUBSCRIPTION_FILTER_PRESENT")
    require(not attributes.get("RedrivePolicy") or attributes["RedrivePolicy"] == "{}", "SUBSCRIPTION_REDRIVE_PRESENT")
    status = attributes.get("PendingConfirmation")
    require(status in {"true", "false"}, "SUBSCRIPTION_CONFIRMATION_UNKNOWN")
    return "pending" if status == "true" else "confirmed"


def verify(sessions, settings: Settings) -> dict:
    s3, sns, iam, cw = (sessions.client(s) for s in ("s3", "sns", "iam", "cloudwatch"))
    bucket = {"Bucket": settings.bucket, "ExpectedBucketOwner": settings.account}
    policies = policy_documents(settings.account)
    require(s3.get_bucket_location(**bucket).get("LocationConstraint") == REGION, "BACKUP_REGION_MISMATCH")
    public = s3.get_public_access_block(**bucket)["PublicAccessBlockConfiguration"]
    require(public == {"BlockPublicAcls": True, "BlockPublicPolicy": True,
                       "IgnorePublicAcls": True, "RestrictPublicBuckets": True}, "PUBLIC_ACCESS_NOT_BLOCKED")
    ownership = s3.get_bucket_ownership_controls(**bucket)["OwnershipControls"]["Rules"]
    require(ownership == [{"ObjectOwnership": "BucketOwnerEnforced"}], "OWNERSHIP_MISMATCH")
    versioning = s3.get_bucket_versioning(**bucket)
    require(versioning.get("Status") == "Enabled" and versioning.get("MFADelete") in (None, "Disabled"),
            "VERSIONING_MISMATCH")
    encryption = s3.get_bucket_encryption(**bucket)["ServerSideEncryptionConfiguration"]["Rules"]
    require(len(encryption) == 1
            and encryption[0].get("ApplyServerSideEncryptionByDefault") == {"SSEAlgorithm": "AES256"}
            and encryption[0].get("BucketKeyEnabled") in (None, False), "ENCRYPTION_MISMATCH")
    lifecycle = s3.get_bucket_lifecycle_configuration(**bucket)["Rules"]
    require(len(lifecycle) == 2, "LIFECYCLE_MISMATCH")
    rules = {r["ID"]: dict(r) for r in lifecycle}
    require(len(rules) == 2, "LIFECYCLE_MISMATCH")
    for rule in rules.values():
        if rule.get("Filter") == {"Prefix": ""}:
            rule["Filter"] = {}
    require(rules == {
        "bounded-recovery-window": {"ID": "bounded-recovery-window", "Status": "Enabled", "Filter": {},
            "Expiration": {"Days": 7}, "NoncurrentVersionExpiration": {"NoncurrentDays": 7},
            "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}},
        "remove-expired-markers": {"ID": "remove-expired-markers", "Status": "Enabled", "Filter": {},
            "Expiration": {"ExpiredObjectDeleteMarker": True}},
    }, "LIFECYCLE_MISMATCH")
    require(policy_canonical(s3.get_bucket_policy(**bucket)["Policy"]) == policy_canonical(policies["bucket"]),
            "BUCKET_POLICY_MISMATCH")
    require(s3.get_bucket_policy_status(**bucket)["PolicyStatus"].get("IsPublic") is False,
            "BUCKET_POLICY_PUBLIC")
    tags(s3.get_bucket_tagging(**bucket)["TagSet"])
    acl = s3.get_bucket_acl(**bucket)
    grants = acl.get("Grants", [])
    require(len(grants) == 1 and grants[0].get("Permission") == "FULL_CONTROL"
            and grants[0].get("Grantee", {}).get("Type") == "CanonicalUser"
            and grants[0]["Grantee"].get("ID") == acl.get("Owner", {}).get("ID")
            and bool(acl.get("Owner", {}).get("ID")), "ACL_MISMATCH")
    for name in POLICY_NAMES:
        arn = settings.policy_arn(name)
        policy = iam.get_policy(PolicyArn=arn)["Policy"]
        require(policy.get("Arn") == arn and policy.get("Path") == "/"
                and policy.get("PolicyName") == POLICY_NAMES[name]
                and policy.get("AttachmentCount") == 0 and policy.get("PermissionsBoundaryUsageCount") == 0,
                "IAM_POLICY_IDENTITY_OR_ATTACHMENT_MISMATCH")
        require(policy.get("DefaultVersionId") == "v1", "IAM_POLICY_VERSION_CHANGED")
        document = iam.get_policy_version(PolicyArn=arn, VersionId="v1")["PolicyVersion"]
        require(document.get("IsDefaultVersion") is True, "IAM_POLICY_VERSION_CHANGED")
        require(policy_canonical(parse_iam_document(document["Document"])) == policy_canonical(policies[name]),
                "IAM_POLICY_DOCUMENT_MISMATCH")
        policy_tags = iam.list_policy_tags(PolicyArn=arn)
        require(not policy_tags.get("IsTruncated") and not policy_tags.get("Marker"), "IAM_TAGS_TRUNCATED")
        tags(policy_tags.get("Tags", []))
    attributes = sns.get_topic_attributes(TopicArn=settings.topic)["Attributes"]
    require(attributes.get("TopicArn") == settings.topic and attributes.get("Owner") == settings.account,
            "TOPIC_IDENTITY_MISMATCH")
    require(attributes.get("FifoTopic", "false") == "false" and not attributes.get("KmsMasterKeyId"),
            "TOPIC_SETTINGS_MISMATCH")
    verify_topic_policy(attributes.get("Policy", ""), settings)
    tags(sns.list_tags_for_resource(ResourceArn=settings.topic).get("Tags", []))
    confirmation = subscription_state(sns, settings)
    result = cw.describe_alarms(AlarmNames=[settings.alarm.rsplit(":", 1)[1]], AlarmTypes=["MetricAlarm"])
    require(not result.get("NextToken") and not result.get("CompositeAlarms")
            and len(result.get("MetricAlarms", [])) == 1, "ALARM_MISSING_OR_AMBIGUOUS")
    alarm = result["MetricAlarms"][0]
    require(alarm.get("AlarmArn") == settings.alarm, "ALARM_IDENTITY_MISMATCH")
    mapping = {
        "alarm_name": "AlarmName", "alarm_description": "AlarmDescription", "namespace": "Namespace",
        "metric_name": "MetricName", "comparison_operator": "ComparisonOperator", "threshold": "Threshold",
        "period": "Period", "evaluation_periods": "EvaluationPeriods", "datapoints_to_alarm": "DatapointsToAlarm",
        "statistic": "Statistic", "treat_missing_data": "TreatMissingData", "actions_enabled": "ActionsEnabled",
        "alarm_actions": "AlarmActions", "ok_actions": "OKActions",
    }
    expected = expected_values(settings.account, settings.email)[ALARM_ADDRESS]
    for tf_key, api_key in mapping.items():
        compare(alarm.get(api_key), expected[tf_key])
    dimensions = alarm.get("Dimensions", [])
    require(len(dimensions) == 1 and {d["Name"]: d["Value"] for d in dimensions} == expected["dimensions"],
            "ALARM_DIMENSIONS_MISMATCH")
    require(not alarm.get("InsufficientDataActions") and not alarm.get("Metrics")
            and not alarm.get("ExtendedStatistic") and not alarm.get("ThresholdMetricId")
            and not alarm.get("Unit"), "UNEXPECTED_ALARM_SETTINGS")
    tags(cw.list_tags_for_resource(ResourceARN=settings.alarm).get("Tags", []))
    state = alarm.get("StateValue")
    require(state in {"OK", "ALARM", "INSUFFICIENT_DATA"}, "ALARM_STATE_UNKNOWN")
    return {"infrastructure_settings_verified": True, "subscription_state": confirmation,
            "alarm_state": state, "unattached_policies_verified": True,
            "topic_policy_owner_scope_verified": True}
