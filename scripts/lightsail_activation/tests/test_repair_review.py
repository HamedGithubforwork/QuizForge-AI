from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from scripts.lightsail_activation.repair_review import (
    BLUEPRINT, BUNDLE, DEFAULT_TAGS, EXISTING, FINAL, REPAIR_CREATES,
    Refused, _safe_side_effect_diagnostics, review_plan,
)
from scripts.lightsail_activation.review import PROVIDER_NAME, Settings


SETTINGS = Settings(
    "arn:aws:iam::123456789012:role/synthetic-deployer",
    "synthetic-state-bucket",
    "synthetic@example.com",
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakesynthetickeyonly synthetic",
    "192.0.2.10/32",
)

CATALOG = {
    "schema": 1,
    "region": "ca-central-1",
    "lightsail_bundle": BUNDLE,
    "lightsail_bundle_available": True,
    "lightsail_blueprint": BLUEPRINT,
    "lightsail_blueprint_available": True,
    "external_budget_name": "quizforge-monthly-account-cost",
    "external_budget_monthly_usd": 20,
    "external_budget_verified": True,
}


def values():
    result = {address: {} for address in FINAL}
    result["aws_lightsail_key_pair.operator"] = {
        "name": "quizforge-production-operator",
        "public_key": SETTINGS.ssh_key,
    }
    result["aws_lightsail_static_ip.server"] = {
        "name": "quizforge-production-lightsail",
    }
    result["aws_cognito_user_pool.browser"] = {
        "name": "quizforge-production-lightsail",
        "deletion_protection": "ACTIVE",
        "mfa_configuration": "ON",
        "admin_create_user_config": [{"allow_admin_create_user_only": True}],
    }
    result["aws_lightsail_instance.server"] = {
        "name": "quizforge-production-lightsail",
        "availability_zone": "ca-central-1a",
        "blueprint_id": BLUEPRINT,
        "bundle_id": BUNDLE,
        "ip_address_type": "ipv4",
        "key_pair_name": "quizforge-production-operator",
    }
    result["aws_lightsail_instance_public_ports.server"] = {
        "port_info": [
            {"protocol": "tcp", "from_port": 22, "to_port": 22,
             "cidrs": [SETTINGS.admin_cidr], "ipv6_cidrs": [], "cidr_list_aliases": []},
            {"protocol": "tcp", "from_port": 80, "to_port": 80,
             "cidrs": ["0.0.0.0/0"], "ipv6_cidrs": [], "cidr_list_aliases": []},
            {"protocol": "tcp", "from_port": 443, "to_port": 443,
             "cidrs": ["0.0.0.0/0"], "ipv6_cidrs": [], "cidr_list_aliases": []},
        ],
    }
    topic = "arn:aws:sns:ca-central-1:123456789012:quizforge-production-lightsail-alerts"
    result["aws_sns_topic_policy.alerts"] = {
        "arn": topic,
        "policy": json.dumps({
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Principal": {"Service": "cloudwatch.amazonaws.com"},
                "Action": "SNS:Publish",
                "Resource": topic,
                "Condition": {"StringEquals": {"AWS:SourceOwner": "123456789012"}},
            }],
        }),
    }
    return result


def configuration():
    configs = []
    for address in sorted(FINAL):
        config = {
            "address": address,
            "mode": "managed",
            "type": address.split(".")[0],
            "name": address.split(".")[1],
            "expressions": {},
        }
        if address == "aws_lightsail_static_ip_attachment.server":
            config["expressions"] = {
                "static_ip_name": {
                    "references": ["aws_lightsail_static_ip.server.id"]
                },
                "instance_name": {
                    "references": ["aws_lightsail_instance.server.id"]
                },
            }
        if address == "aws_lightsail_instance_public_ports.server":
            config["expressions"] = {
                "instance_name": {
                    "references": ["aws_lightsail_instance.server.name"]
                },
            }
        configs.append(config)
    return configs


def plan():
    after = values()
    changes = []
    for address in sorted(FINAL):
        created = address in REPAIR_CREATES
        changes.append({
            "address": address,
            "mode": "managed",
            "type": address.split(".")[0],
            "provider_name": PROVIDER_NAME,
            "change": {
                "actions": ["create"] if created else ["no-op"],
                "before": None if created else copy.deepcopy(after[address]),
                "after": copy.deepcopy(after[address]),
                "after_unknown": {},
            },
        })
    prior = [{
        "address": address,
        "mode": "managed",
        "type": address.split(".")[0],
        "name": address.split(".")[1],
        "values": copy.deepcopy(after[address]),
    } for address in sorted(EXISTING)]
    return {
        "format_version": "1.2",
        "terraform_version": "1.14.7",
        "errored": False,
        "applyable": True,
        "complete": True,
        "variables": {
            "alert_email": {"value": SETTINGS.email},
            "ssh_public_key": {"value": SETTINGS.ssh_key},
            "admin_ipv4_cidr": {"value": SETTINGS.admin_cidr},
            "public_signup": {"value": False},
        },
        "prior_state": {"values": {"root_module": {"resources": prior}}},
        "configuration": {"root_module": {"resources": configuration()}},
        "resource_changes": changes,
        "checks": [],
    }


def resource(document, address):
    return next(item for item in document["resource_changes"]
                if item["address"] == address)


def approved_refresh_drift():
    def item(address, before, after):
        return {
            "address": address,
            "mode": "managed",
            "provider_name": PROVIDER_NAME,
            "change": {
                "actions": ["update"],
                "before": before,
                "after": after,
            },
        }

    return [
        item(
            "aws_cloudwatch_log_group.recovery",
            {"tags": None},
            {"tags": dict(DEFAULT_TAGS)},
        ),
        item(
            "aws_cloudwatch_metric_alarm.status",
            {"insufficient_data_actions": None, "tags": {}},
            {"insufficient_data_actions": [], "tags": dict(DEFAULT_TAGS)},
        ),
        item(
            "aws_cognito_user_pool.browser",
            {"domain": None, "tags": None},
            {"domain": f"quizforge-{SETTINGS.account}", "tags": dict(DEFAULT_TAGS)},
        ),
        item(
            "aws_iam_policy.host_health",
            {"tags": None},
            {"tags": dict(DEFAULT_TAGS)},
        ),
        item(
            "aws_iam_role.recovery",
            {"inline_policy": None, "tags": None},
            {"inline_policy": [], "tags": dict(DEFAULT_TAGS)},
        ),
        item(
            "aws_lambda_function.recovery",
            {"layers": None, "tags": None},
            {"layers": [], "tags": dict(DEFAULT_TAGS)},
        ),
        item(
            "aws_lightsail_key_pair.operator",
            {"tags": None},
            {"tags": dict(DEFAULT_TAGS)},
        ),
        item(
            "aws_sns_topic.alerts",
            {"tags": None},
            {"tags": dict(DEFAULT_TAGS)},
        ),
    ]


class RepairReviewTests(unittest.TestCase):
    def refused(self, mutate, catalog=CATALOG):
        document = plan()
        mutate(document)
        with self.assertRaises(Refused):
            review_plan(document, SETTINGS, catalog)

    def test_exact_four_create_repair_passes(self):
        manifest = review_plan(plan(), SETTINGS, CATALOG)
        self.assertEqual(manifest["prior_state_managed_resources"], 14)
        self.assertEqual(manifest["existing_resources_noop"], 14)
        self.assertEqual(manifest["creates"], 4)
        self.assertEqual(manifest["updates"], 0)
        self.assertEqual(manifest["deletes"], 0)
        self.assertEqual(manifest["replacements"], 0)
        self.assertEqual(set(manifest["create_addresses"]), set(REPAIR_CREATES))
        self.assertTrue(manifest["external_budget_managed_separately"])
        self.assertEqual(manifest["lightsail_stack_budget_resources"], 0)
        raw = json.dumps(manifest)
        for private in (
            SETTINGS.email, SETTINGS.account, SETTINGS.role,
            SETTINGS.state_bucket, SETTINGS.ssh_key, SETTINGS.admin_cidr,
        ):
            self.assertNotIn(private, raw)

    def test_exact_observed_refresh_normalizations_are_allowed(self):
        document = plan()
        document["resource_drift"] = approved_refresh_drift()
        manifest = review_plan(document, SETTINGS, CATALOG)
        self.assertEqual(manifest["approved_refresh_drift_entries"], 8)
        self.assertTrue(manifest["approved_refresh_drift_only"])
        self.assertEqual(manifest["updates"], 0)
        self.assertEqual(manifest["deletes"], 0)
        self.assertEqual(manifest["replacements"], 0)

    def test_refresh_drift_wrong_values_or_actions_are_refused(self):
        mutators = [
            lambda drift: drift[0]["change"]["after"].update(
                tags={"Project": "Other"}
            ),
            lambda drift: drift[1]["change"]["after"].update(
                insufficient_data_actions=["arn:aws:sns:ca-central-1:123456789012:unexpected"]
            ),
            lambda drift: drift[2]["change"]["after"].update(
                domain="unexpected-domain"
            ),
            lambda drift: drift[4]["change"]["after"].update(
                inline_policy=[{"name": "unexpected"}]
            ),
            lambda drift: drift[5]["change"]["after"].update(
                layers=["arn:aws:lambda:ca-central-1:123456789012:layer:unexpected:1"]
            ),
            lambda drift: drift[0]["change"].update(actions=["delete"]),
            lambda drift: drift[0]["change"].update(replace_paths=[["tags"]]),
            lambda drift: drift[0].update(address="aws_s3_bucket.unexpected"),
        ]
        for mutate in mutators:
            with self.subTest(mutate=mutate):
                document = plan()
                drift = approved_refresh_drift()
                mutate(drift)
                document["resource_drift"] = drift
                with self.assertRaisesRegex(Refused, "UNEXPECTED_PLAN_SIDE_EFFECTS"):
                    review_plan(document, SETTINGS, CATALOG)

    def test_refresh_drift_can_disappear_or_reverse_without_weakening_checks(self):
        document = plan()
        reverse = approved_refresh_drift()[:3]
        for item in reverse:
            change = item["change"]
            change["before"], change["after"] = change["after"], change["before"]
        document["resource_drift"] = reverse
        manifest = review_plan(document, SETTINGS, CATALOG)
        self.assertEqual(manifest["approved_refresh_drift_entries"], 3)

        clean = review_plan(plan(), SETTINGS, CATALOG)
        self.assertEqual(clean["approved_refresh_drift_entries"], 0)

    def test_updates_deletes_replacements_and_imports_are_refused(self):
        target = sorted(EXISTING)[0]
        for actions in (["update"], ["delete"], ["delete", "create"]):
            with self.subTest(actions=actions):
                self.refused(lambda p, a=actions:
                             resource(p, target)["change"].update(actions=a))
        self.refused(lambda p: resource(
            p, "aws_lightsail_instance.server"
        )["change"].update(replace_paths=[["bundle_id"]]))
        self.refused(lambda p: resource(
            p, "aws_lightsail_instance.server"
        )["change"].update(importing={"id": "x"}))

    def test_partial_state_and_duplicate_budget_are_refused(self):
        self.refused(lambda p:
                     p["prior_state"]["values"]["root_module"]["resources"].pop())
        self.refused(lambda p: p["variables"].update(
            monthly_budget_usd={"value": 20}
        ))
        def add_budget(p):
            p["configuration"]["root_module"]["resources"].append({
                "address": "aws_budgets_budget.monthly",
                "mode": "managed",
                "type": "aws_budgets_budget",
                "name": "monthly",
                "expressions": {},
            })
        self.refused(add_budget)

    def test_server_firewall_and_topic_policy_contracts_are_refused(self):
        self.refused(lambda p: resource(
            p, "aws_lightsail_instance.server"
        )["change"]["after"].update(bundle_id="medium_3_0"))

        def open_ssh(p):
            ports = resource(
                p, "aws_lightsail_instance_public_ports.server"
            )["change"]["after"]["port_info"]
            next(item for item in ports if item["from_port"] == 22)["cidrs"] = ["0.0.0.0/0"]
        self.refused(open_ssh)

        def add_budget_publisher(p):
            value = resource(
                p, "aws_sns_topic_policy.alerts"
            )["change"]["after"]
            doc = json.loads(value["policy"])
            doc["Statement"].append({
                "Effect": "Allow",
                "Principal": {"Service": "budgets.amazonaws.com"},
                "Action": "SNS:Publish",
                "Resource": value["arn"],
            })
            value["policy"] = json.dumps(doc)
        self.refused(add_budget_publisher)

    def test_side_effect_diagnostics_report_only_safe_counts_and_known_addresses(self):
        document = plan()
        known = sorted(EXISTING)[0]
        document["resource_drift"] = [
            {
                "address": known,
                "mode": "managed",
                "change": {
                    "actions": ["update"],
                    "before": {
                        "arn": f"arn:synthetic:{SETTINGS.account}",
                        "tags": {SETTINGS.email: SETTINGS.ssh_key},
                        "kms_key_id": SETTINGS.role,
                        "not-a-schema-field": SETTINGS.admin_cidr,
                    },
                    "after": {
                        "arn": f"arn:synthetic:{SETTINGS.account}:changed",
                        "tags": {SETTINGS.email: SETTINGS.admin_cidr},
                        "kms_key_id": SETTINGS.role,
                        "not-a-schema-field": SETTINGS.ssh_key,
                    },
                },
            },
            {
                "address": "aws_example.secret-looking-resource",
                "change": {"before": {"account": SETTINGS.account}},
            },
        ]
        document["deferred_changes"] = [{
            "resource_change": {
                "address": sorted(REPAIR_CREATES)[0],
                "change": {"after": {"cidr": SETTINGS.admin_cidr}},
            }
        }]
        document["action_invocations"] = [{
            "address": "action.example",
            "config_values": {"role": SETTINGS.role},
        }]

        diagnostics = _safe_side_effect_diagnostics(document)
        self.assertEqual(diagnostics["resource_drift_count"], 2)
        self.assertEqual(diagnostics["known_resource_drift_addresses"], [known])
        self.assertEqual(
            diagnostics["known_resource_drift_attributes"],
            {known: ["arn", "tags"]},
        )
        self.assertEqual(diagnostics["unexpected_resource_drift_count"], 1)
        self.assertEqual(diagnostics["deferred_change_count"], 1)
        self.assertEqual(
            diagnostics["known_deferred_change_addresses"],
            [sorted(REPAIR_CREATES)[0]],
        )
        self.assertEqual(diagnostics["unexpected_deferred_change_count"], 0)
        self.assertEqual(diagnostics["action_invocation_count"], 1)

        raw = json.dumps(diagnostics)
        for private in (
            SETTINGS.email, SETTINGS.account, SETTINGS.role,
            SETTINGS.state_bucket, SETTINGS.ssh_key, SETTINGS.admin_cidr,
            "aws_example.secret-looking-resource",
            "not-a-schema-field",
        ):
            self.assertNotIn(private, raw)

        with self.assertRaisesRegex(Refused, "UNEXPECTED_PLAN_SIDE_EFFECTS"):
            review_plan(document, SETTINGS, CATALOG)

    def test_drift_attribute_diagnostics_never_emit_nested_keys_or_values(self):
        document = plan()
        known = sorted(EXISTING)[1]
        document["resource_drift"] = [{
            "address": known,
            "change": {
                "before": {
                    "policy": {
                        SETTINGS.email: {
                            "credential": SETTINGS.ssh_key,
                            "cidr": SETTINGS.admin_cidr,
                        }
                    },
                    "id": SETTINGS.account,
                },
                "after": {
                    "policy": {
                        SETTINGS.email: {
                            "credential": SETTINGS.role,
                            "cidr": "198.51.100.2/32",
                        }
                    },
                    "id": SETTINGS.account,
                },
            },
        }]

        diagnostics = _safe_side_effect_diagnostics(document)
        self.assertEqual(
            diagnostics["known_resource_drift_attributes"],
            {known: ["policy"]},
        )
        raw = json.dumps(diagnostics)
        for private in (
            SETTINGS.email,
            SETTINGS.account,
            SETTINGS.role,
            SETTINGS.ssh_key,
            SETTINGS.admin_cidr,
            "credential",
            "cidr",
        ):
            self.assertNotIn(private, raw)

    def test_unavailable_catalog_or_unverified_external_budget_is_refused(self):
        for key in (
            "lightsail_bundle_available",
            "lightsail_blueprint_available",
            "external_budget_verified",
        ):
            with self.subTest(key=key):
                catalog = dict(CATALOG)
                catalog[key] = False
                with self.assertRaises(Refused):
                    review_plan(plan(), SETTINGS, catalog)


class WorkflowTests(unittest.TestCase):
    def test_repair_inspection_is_manual_read_only_and_never_applies(self):
        workflow = Path(
            ".github/workflows/lightsail-production-repair-inspect.yml"
        ).read_text()
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertIn("ReadOnlyAccess", workflow)
        self.assertIn("-lock=false", workflow)
        self.assertIn("repair_review catalog", workflow)
        self.assertIn("repair_review review", workflow)
        self.assertNotIn("terraform apply", workflow)
        self.assertNotIn("terraform destroy", workflow)
        self.assertNotIn("terraform import", workflow)
        self.assertNotIn("-auto-approve", workflow)
        self.assertNotIn("route53", workflow.lower())
        self.assertNotIn("public_signup=true", workflow)
        self.assertIn("permanent-lightsail-repair-inspection-summary", workflow)

    def test_pr_validation_has_no_cloud_credentials(self):
        workflow = Path(
            ".github/workflows/lightsail-production-repair-inspect.yml"
        ).read_text()
        validation = workflow.split("  validate:\n", 1)[1].split("  inspect:\n", 1)[0]
        self.assertNotIn("id-token: write", validation)
        self.assertNotIn("secrets.", validation)
        self.assertNotIn("configure-aws-credentials", validation)


if __name__ == "__main__":
    unittest.main()
