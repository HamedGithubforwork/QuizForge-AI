from __future__ import annotations

from datetime import datetime, timezone
import json
import unittest

from scripts.lightsail_activation.apply_failure_diagnose import (
    DEFAULT_TAGS,
    classify_error,
    denied_action_from_message,
    incident_cloudtrail,
    parse_tags,
    recent_create_history,
    safe_condition_keys,
)
from scripts.lightsail_activation.tests.test_repair_review import SETTINGS


class FakeCloudTrail:
    def __init__(self, events):
        self.events = events

    def lookup_events(self, **kwargs):
        key = kwargs["LookupAttributes"][0]["AttributeKey"]
        value = kwargs["LookupAttributes"][0]["AttributeValue"]
        matched = []
        for payload in self.events:
            if key == "EventSource" and payload.get("eventSource") != value:
                continue
            if key == "EventName" and payload.get("eventName") != value:
                continue
            matched.append({
                "EventTime": datetime(2026, 9, 24, 0, 36, tzinfo=timezone.utc),
                "CloudTrailEvent": json.dumps(payload),
            })
        return {"Events": matched}


class ApplyFailureDiagnosticTests(unittest.TestCase):
    def test_failure_classification_is_specific_without_echoing_message(self):
        self.assertEqual(
            classify_error("AccessDeniedException", "not authorized to perform something"),
            "authorization",
        )
        self.assertEqual(
            classify_error("ServiceLimitExceededException", "quota reached"),
            "service_limit_or_quota",
        )
        self.assertEqual(
            denied_action_from_message(
                "User is not authorized to perform: lightsail:CreateInstances on resource"
            ),
            "lightsail:CreateInstances",
        )
        self.assertIsNone(denied_action_from_message("secret action custom:DoThing"))

    def test_tag_parser_reports_only_safe_shape(self):
        params = {
            "tags": [
                {"key": "Project", "value": DEFAULT_TAGS["Project"]},
                {"key": "Environment", "value": DEFAULT_TAGS["Environment"]},
                {"key": "Temporary", "value": DEFAULT_TAGS["Temporary"]},
                {"key": "SensitiveCustomKey", "value": SETTINGS.ssh_key},
            ]
        }
        result = parse_tags(params)
        self.assertTrue(result["default_tags_exact"])
        self.assertFalse(result["purpose_tag_present"])
        self.assertEqual(result["unexpected_tag_key_count"], 1)
        raw = json.dumps(result)
        self.assertNotIn("SensitiveCustomKey", raw)
        self.assertNotIn(SETTINGS.ssh_key, raw)

    def test_incident_cloudtrail_sanitizes_access_denial_and_request_contract(self):
        payload = {
            "eventSource": "lightsail.amazonaws.com",
            "eventName": "CreateInstances",
            "errorCode": "AccessDeniedException",
            "errorMessage": (
                f"arn:aws:iam::{SETTINGS.account}:role/private is not authorized to perform "
                "lightsail:CreateInstances because secret-private-policy denied it"
            ),
            "userIdentity": {
                "sessionContext": {
                    "sessionIssuer": {"arn": SETTINGS.role}
                }
            },
            "requestParameters": {
                "availabilityZone": "ca-central-1a",
                "blueprintId": "ubuntu_24_04",
                "bundleId": "small_3_0",
                "instanceNames": ["quizforge-production-lightsail"],
                "tags": [
                    {"key": "Project", "value": "QuizForge-AI"},
                    {"key": "Environment", "value": "production-lightsail"},
                    {"key": "Temporary", "value": "false"},
                ],
            },
        }
        report = incident_cloudtrail(FakeCloudTrail([payload]), SETTINGS)
        self.assertTrue(report["available"])
        self.assertEqual(report["lightsail_failure_count"], 1)
        event = report["events"][0]
        self.assertEqual(event["denied_action"], "lightsail:CreateInstances")
        self.assertEqual(event["failure_class"], "authorization")
        self.assertTrue(event["configured_role_session"])
        self.assertTrue(event["availability_zone_expected"])
        self.assertTrue(event["blueprint_expected"])
        self.assertTrue(event["bundle_expected"])
        self.assertTrue(event["tags"]["default_tags_exact"])
        self.assertFalse(event["tags"]["purpose_tag_present"])

        raw = json.dumps(report)
        for private in (SETTINGS.account, SETTINGS.role, "secret-private-policy"):
            self.assertNotIn(private, raw)

    def test_recent_history_compares_success_tag_shapes_without_values(self):
        events = [
            {
                "eventSource": "lightsail.amazonaws.com",
                "eventName": "CreateInstances",
                "userIdentity": {
                    "sessionContext": {"sessionIssuer": {"arn": SETTINGS.role}}
                },
                "requestParameters": {
                    "tags": [
                        {"key": "Purpose", "value": "quizforge-capacity-test"},
                        {"key": "TestId", "value": "private-id"},
                        {"key": "DeleteAfter", "value": "private-time"},
                    ]
                },
            },
            {
                "eventSource": "lightsail.amazonaws.com",
                "eventName": "CreateInstances",
                "errorCode": "AccessDeniedException",
                "errorMessage": "not authorized",
                "requestParameters": {
                    "tags": [
                        {"key": "Project", "value": "QuizForge-AI"},
                        {"key": "Environment", "value": "production-lightsail"},
                        {"key": "Temporary", "value": "false"},
                    ]
                },
            },
        ]
        report = recent_create_history(FakeCloudTrail(events), SETTINGS)
        self.assertEqual(report["event_count"], 2)
        self.assertEqual(report["success_count"], 1)
        self.assertEqual(report["failure_count"], 1)
        self.assertEqual(report["same_configured_role_success_count"], 1)
        self.assertEqual(report["success_with_purpose_tag_count"], 1)
        self.assertEqual(report["success_with_default_tags_count"], 0)
        self.assertNotIn("private-id", json.dumps(report))

    def test_condition_key_summary_only_allows_known_keys(self):
        statement = {
            "Condition": {
                "StringEquals": {
                    "aws:RequestedRegion": "ca-central-1",
                    "aws:RequestTag/Purpose": "quizforge-capacity-test",
                    "secret:PrivateKey": SETTINGS.email,
                }
            }
        }
        result = safe_condition_keys(statement)
        self.assertEqual(
            result,
            ["aws:RequestTag/Purpose", "aws:RequestedRegion"],
        )
        self.assertNotIn(SETTINGS.email, json.dumps(result))


if __name__ == "__main__":
    unittest.main()
