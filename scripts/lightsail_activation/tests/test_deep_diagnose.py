from __future__ import annotations

import copy
import json
import unittest

from scripts.lightsail_activation.deep_diagnose import analyze
from scripts.lightsail_activation.repair_review import DEFAULT_TAGS
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
        self.assertEqual(report["resource_drift_count"], 3)
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

    def test_plan_action_summary_detects_exact_repair_shape(self):
        report = analyze(plan(), SETTINGS, CATALOG)
        self.assertEqual(report["plan_action_counts"]["create"], 4)
        self.assertEqual(report["plan_action_counts"]["noop"], 14)
        self.assertEqual(report["plan_action_counts"]["update"], 0)
        self.assertEqual(report["plan_action_counts"]["delete"], 0)
        self.assertEqual(report["plan_action_counts"]["replace"], 0)
        self.assertEqual(report["prior_managed_resource_count"], 14)
        self.assertEqual(report["resource_drift_count"], 0)


if __name__ == "__main__":
    unittest.main()
