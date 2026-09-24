from __future__ import annotations

import copy
import json
import unittest

from scripts.lightsail_activation.deep_diagnose import analyze
from scripts.lightsail_activation.repair_review import DEFAULT_TAGS, EXISTING, REPAIR_CREATES
from scripts.lightsail_activation.review import PROVIDER_NAME
from scripts.lightsail_activation.tests.test_repair_review import (
    CATALOG,
    SETTINGS,
    plan,
    resource,
)


class DeepDiagnosticTests(unittest.TestCase):
    def test_diagnostic_reports_shapes_without_private_values(self):
        document = plan()
        separate = resource(document, "aws_iam_role_policy.recovery")
        separate["change"]["after"]["policy"] = json.dumps({
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Resource": f"arn:aws:cognito-idp:ca-central-1:{SETTINGS.account}:userpool/example",
            }],
        })
        sns_separate = resource(document, "aws_sns_topic_policy.alerts")
        sns_policy = sns_separate["change"]["after"]["policy"]
        document["resource_drift"] = [
            {
                "address": "aws_iam_role.recovery",
                "mode": "managed",
                "provider_name": PROVIDER_NAME,
                "change": {
                    "actions": ["update"],
                    "before": {"inline_policy": None, "tags": None},
                    "after": {
                        "inline_policy": [{
                            "name": f"private-{SETTINGS.email}",
                            "policy": separate["change"]["after"]["policy"],
                        }],
                        "tags": dict(DEFAULT_TAGS),
                    },
                },
            },
            {
                "address": "aws_cognito_user_pool.browser",
                "mode": "managed",
                "provider_name": PROVIDER_NAME,
                "change": {
                    "actions": ["update"],
                    "before": {"domain": None},
                    "after": {"domain": f"quizforge-{SETTINGS.account}"},
                },
            },
            {
                "address": "aws_sns_topic.alerts",
                "mode": "managed",
                "provider_name": PROVIDER_NAME,
                "change": {
                    "actions": ["update"],
                    "before": {"policy": None},
                    "after": {"policy": sns_policy},
                },
            },
            {
                "address": "aws_example.private_resource_name",
                "mode": "managed",
                "provider_name": PROVIDER_NAME,
                "change": {
                    "actions": ["update"],
                    "before": {"secret": SETTINGS.ssh_key},
                    "after": {"secret": SETTINGS.role},
                },
            },
        ]

        report = analyze(document, SETTINGS, CATALOG)
        self.assertEqual(report["resource_drift_count"], 4)
        self.assertEqual(report["unexpected_resource_drift_count"], 1)
        self.assertEqual(
            report["rest_of_plan_contract_after_ignoring_refresh_drift"],
            "PASS",
        )
        role = report["drift_resources"]["aws_iam_role.recovery"]
        self.assertEqual(role["changed_attributes"], ["inline_policy", "tags"])
        self.assertTrue(role["inline_policy"]["after"]["matches_separate_policy"])
        self.assertEqual(role["tags"]["after"]["kind"], "exact_default_tags")
        pool = report["drift_resources"]["aws_cognito_user_pool.browser"]
        self.assertTrue(pool["domain"]["after_matches_expected_prefix"])
        topic = report["drift_resources"]["aws_sns_topic.alerts"]
        self.assertEqual(topic["changed_attributes"], ["policy"])
        self.assertTrue(topic["policy"]["after"]["matches_separate_policy"])
        self.assertEqual(topic["policy"]["before"]["kind"], "null")

        raw = json.dumps(report)
        for private in (
            SETTINGS.email,
            SETTINGS.account,
            SETTINGS.role,
            SETTINGS.state_bucket,
            SETTINGS.ssh_key,
            SETTINGS.admin_cidr,
            "aws_example.private_resource_name",
            f"private-{SETTINGS.email}",
        ):
            self.assertNotIn(private, raw)

    def test_final_instance_refresh_compares_live_ip_without_emitting_it(self):
        document = plan()
        old_ip = "198.51.100.10"
        static_ip = "198.51.100.20"
        document["resource_drift"] = [{
            "address": "aws_lightsail_instance.server",
            "mode": "managed",
            "provider_name": PROVIDER_NAME,
            "change": {
                "actions": ["update"],
                "before": {
                    "is_static_ip": False,
                    "public_ip_address": old_ip,
                    "tags": None,
                },
                "after": {
                    "is_static_ip": True,
                    "public_ip_address": static_ip,
                    "tags": {},
                },
            },
        }]
        live = {
            "summary": {
                "instance_exists": True,
                "static_ip_exists": True,
                "instance_blueprint_expected": True,
                "instance_bundle_expected": True,
                "instance_availability_zone_expected": True,
                "instance_reports_static_ip": True,
                "static_ip_attached_to_expected_instance": True,
                "instance_public_ip_matches_static_ip": True,
                "public_ports_contract_ok": True,
            },
            "_instance_public_ip": static_ip,
            "_static_public_ip": static_ip,
            "_instance_is_static_ip": True,
        }

        report = analyze(document, SETTINGS, CATALOG, live)
        item = report["drift_resources"]["aws_lightsail_instance.server"]
        self.assertEqual(
            item["changed_attributes"],
            ["is_static_ip", "public_ip_address", "tags"],
        )
        self.assertFalse(item["is_static_ip"]["before"])
        self.assertTrue(item["is_static_ip"]["after"])
        self.assertTrue(item["is_static_ip"]["after_matches_live"])
        self.assertTrue(item["public_ip_address"]["changed"])
        self.assertTrue(item["public_ip_address"]["after_matches_live_instance"])
        self.assertTrue(item["public_ip_address"]["after_matches_live_static_ip"])
        self.assertFalse(item["public_ip_address"]["before_matches_live_instance"])
        self.assertFalse(item["public_ip_address"]["before_matches_live_static_ip"])
        self.assertTrue(report["live_lightsail"]["public_ports_contract_ok"])

        raw = json.dumps(report)
        self.assertNotIn(old_ip, raw)
        self.assertNotIn(static_ip, raw)

    def test_plan_action_summary_detects_exact_repair_shape(self):
        report = analyze(plan(), SETTINGS, CATALOG)
        self.assertEqual(report["plan_action_counts"]["create"], len(REPAIR_CREATES))
        self.assertEqual(report["plan_action_counts"]["noop"], len(EXISTING))
        self.assertEqual(report["plan_action_counts"]["update"], 0)
        self.assertEqual(report["plan_action_counts"]["delete"], 0)
        self.assertEqual(report["plan_action_counts"]["replace"], 0)
        self.assertEqual(report["prior_managed_resource_count"], len(EXISTING))
        self.assertEqual(report["resource_drift_count"], 0)


if __name__ == "__main__":
    unittest.main()
