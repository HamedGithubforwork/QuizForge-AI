"""Synthetic fixtures only. These are NOT captured AWS or Terraform evidence."""
from __future__ import annotations

import copy
import json

from scripts.backup_activation.contract import (
    Settings, REPOSITORY, WORKFLOW, TERRAFORM, PROVIDER_NAME, BUCKET_ADDRESS,
    TOPIC_ADDRESS, OWNER_ADDRESS, ALARM_ADDRESS, expected_values, policy_documents,
)

SETTINGS = Settings("arn:aws:iam::123456789012:role/synthetic-deployer", "123456789012",
                    "synthetic-state-bucket", "synthetic-alerts@example.invalid")
SHA = "a" * 40


def environment(mode="inspect"):
    return {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/main",
            "GITHUB_REPOSITORY": REPOSITORY, "GITHUB_WORKFLOW_REF": f"{REPOSITORY}/{WORKFLOW}@refs/heads/main",
            "GITHUB_SHA": SHA, "GITHUB_WORKFLOW_SHA": SHA, "GITHUB_RUN_ATTEMPT": "1",
            "QF_OPERATION": mode, "QF_ROLE_ARN": SETTINGS.role, "QF_STATE_BUCKET": SETTINGS.state_bucket,
            "AWS_BUDGET_ALERT_EMAIL": SETTINGS.email, "TF_WORKSPACE": "default"}


def plan():
    values = expected_values(SETTINGS.account, SETTINGS.email)
    resources, configs = [], []
    for address, after in values.items():
        expressions = {}
        if address.startswith("aws_s3_bucket_"):
            expressions["bucket"] = {"references": [BUCKET_ADDRESS + ".id", BUCKET_ADDRESS]}
        if address == OWNER_ADDRESS:
            expressions["topic_arn"] = {"references": [TOPIC_ADDRESS + ".arn", TOPIC_ADDRESS]}
        if address == ALARM_ADDRESS:
            for key in ("alarm_actions", "ok_actions"):
                expressions[key] = {"references": [TOPIC_ADDRESS + ".arn", TOPIC_ADDRESS]}
        resources.append({"address": address, "type": address.split(".")[0], "mode": "managed",
                          "provider_name": PROVIDER_NAME,
                          "change": {"actions": ["create"], "before": None, "after": after,
                                     "after_unknown": {"id": True}, "after_sensitive": {}}})
        configs.append({"address": address, "mode": "managed", "expressions": expressions})
    return {"format_version": "1.2", "terraform_version": TERRAFORM,
            "errored": False, "applyable": True, "complete": True,
            "variables": {"alert_email": {"value": SETTINGS.email}},
            "configuration": {"root_module": {"resources": configs}},
            "resource_changes": resources, "checks": [{"status": "pass"}]}


def resource(document, address):
    return next(r for r in document["resource_changes"] if r["address"] == address)


class APIError(Exception):
    def __init__(self, code):
        super().__init__("Synthetic diagnostic containing " + SETTINGS.email)
        self.response = {"Error": {"Code": code, "Message": str(self)}}


class Service:
    def __init__(self, responses):
        self.responses, self.calls = responses, []

    def __getattr__(self, method):
        def call(**kwargs):
            self.calls.append((method, kwargs))
            value = self.responses[method]
            if isinstance(value, BaseException):
                raise value
            return value(**kwargs) if callable(value) else copy.deepcopy(value)
        return call


class Clients:
    def __init__(self, responses):
        self.services = {service: Service(values) for service, values in responses.items()}

    def client(self, service, profile="qf-resources"):
        return self.services[service]


def absent_clients():
    return Clients({"s3": {"get_bucket_versioning": APIError("NoSuchBucket")},
                    "sns": {"get_topic_attributes": APIError("NotFound")},
                    "iam": {"get_policy": APIError("NoSuchEntity")},
                    "cloudwatch": {"list_tags_for_resource": APIError("ResourceNotFoundException")}})


def live_clients(confirmation="pending"):
    s = SETTINGS
    tags = [{"Key": "Project", "Value": "QuizForge"}, {"Key": "Purpose", "Value": "production-backup"}]
    documents = policy_documents(s.account)
    def iam_policy(**kwargs):
        arn = kwargs["PolicyArn"]
        return {"Policy": {"Arn": arn, "Path": "/", "PolicyName": arn.rsplit("/", 1)[1],
                           "DefaultVersionId": "v1", "AttachmentCount": 0, "PermissionsBoundaryUsageCount": 0}}
    def iam_version(**kwargs):
        name = next(k for k in ("uploader", "recovery", "health") if s.policy_arn(k) == kwargs["PolicyArn"])
        return {"PolicyVersion": {"IsDefaultVersion": True, "Document": documents[name]}}
    sub_arn = s.topic + ":11111111-2222-3333-4444-555555555555"
    sub = {"TopicArn": s.topic, "Owner": s.account, "Protocol": "email", "Endpoint": s.email,
           "SubscriptionArn": "PendingConfirmation" if confirmation == "pending" else sub_arn}
    attributes = {"TopicArn": s.topic, "Owner": s.account, "Protocol": "email", "Endpoint": s.email,
                  "PendingConfirmation": "false" if confirmation == "confirmed" else "true"}
    topic_policy = {"Version": "2008-10-17", "Id": "__default_policy_ID", "Statement": [{
        "Sid": "__default_statement_ID", "Effect": "Allow", "Principal": {"AWS": "*"},
        "Action": ["SNS:GetTopicAttributes", "SNS:SetTopicAttributes", "SNS:AddPermission", "SNS:RemovePermission",
                   "SNS:DeleteTopic", "SNS:Subscribe", "SNS:ListSubscriptionsByTopic", "SNS:Publish"],
        "Resource": s.topic, "Condition": {"StringEquals": {"AWS:SourceOwner": s.account}}}]}
    return Clients({
        "s3": {
            "get_bucket_location": {"LocationConstraint": "ca-central-1"},
            "get_public_access_block": {"PublicAccessBlockConfiguration": {
                "BlockPublicAcls": True, "BlockPublicPolicy": True, "IgnorePublicAcls": True, "RestrictPublicBuckets": True}},
            "get_bucket_ownership_controls": {"OwnershipControls": {"Rules": [{"ObjectOwnership": "BucketOwnerEnforced"}]}},
            "get_bucket_versioning": {"Status": "Enabled"},
            "get_bucket_encryption": {"ServerSideEncryptionConfiguration": {"Rules": [{
                "ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]}},
            "get_bucket_lifecycle_configuration": {"Rules": [
                {"ID": "bounded-recovery-window", "Status": "Enabled", "Filter": {}, "Expiration": {"Days": 7},
                 "NoncurrentVersionExpiration": {"NoncurrentDays": 7}, "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}},
                {"ID": "remove-expired-markers", "Status": "Enabled", "Filter": {}, "Expiration": {"ExpiredObjectDeleteMarker": True}}]},
            "get_bucket_policy": {"Policy": json.dumps(documents["bucket"])},
            "get_bucket_policy_status": {"PolicyStatus": {"IsPublic": False}},
            "get_bucket_tagging": {"TagSet": tags},
            "get_bucket_acl": {"Owner": {"ID": "synthetic-canonical-owner"}, "Grants": [{"Permission": "FULL_CONTROL",
                "Grantee": {"Type": "CanonicalUser", "ID": "synthetic-canonical-owner"}}]},
        },
        "iam": {"get_policy": iam_policy, "get_policy_version": iam_version, "list_policy_tags": {"Tags": tags}},
        "sns": {"get_topic_attributes": {"Attributes": {"TopicArn": s.topic, "Owner": s.account,
                                                          "Policy": json.dumps(topic_policy)}},
                "list_tags_for_resource": {"Tags": tags},
                "list_subscriptions_by_topic": {"Subscriptions": [sub]},
                "get_subscription_attributes": {"Attributes": attributes}},
        "cloudwatch": {"list_tags_for_resource": {"Tags": tags}, "describe_alarms": {"MetricAlarms": [{
            "AlarmArn": s.alarm, "AlarmName": "quizforge-production-backup-unhealthy",
            "AlarmDescription": "Failed backup, no valid snapshot within 26 hours, or missing hourly host heartbeat.",
            "Namespace": "QuizForge/Backup", "MetricName": "BackupFresh", "ComparisonOperator": "LessThanThreshold",
            "Threshold": 1, "Period": 3600, "EvaluationPeriods": 1, "DatapointsToAlarm": 1,
            "Statistic": "Minimum", "TreatMissingData": "breaching", "ActionsEnabled": True,
            "AlarmActions": [s.topic], "OKActions": [s.topic], "InsufficientDataActions": [],
            "Dimensions": [{"Name": "Deployment", "Value": "production-lightsail"}], "StateValue": "ALARM"}]}},
    })
