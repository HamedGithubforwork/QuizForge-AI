from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from scripts.lightsail_activation.review import (
    EXPECTED, PROVIDER_NAME, Refused, Settings, check_source, review_plan,
)


SETTINGS = Settings(
    "arn:aws:iam::123456789012:role/synthetic-deployer",
    "synthetic-state-bucket",
    "synthetic@example.com",
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakesynthetickeyonly synthetic",
    "192.0.2.10/32",
)


def after_values():
    values = {address: {} for address in EXPECTED}
    values["aws_lightsail_key_pair.operator"] = {
        "name": "quizforge-production-operator",
        "public_key": SETTINGS.ssh_key,
    }
    values["aws_lightsail_instance.server"] = {
        "name": "quizforge-production-lightsail-server",
        "availability_zone": "ca-central-1a",
        "blueprint_id": "ubuntu_24_04",
        "bundle_id": "small_3_0",
        "ip_address_type": "ipv4",
        "key_pair_name": "quizforge-production-operator",
    }
    values["aws_lightsail_static_ip.server"] = {"name": "quizforge-production-lightsail"}
    values["aws_lightsail_instance_public_ports.server"] = {
        "port_info": [
            {"protocol": "tcp", "from_port": 22, "to_port": 22,
             "cidrs": [SETTINGS.admin_cidr], "ipv6_cidrs": [], "cidr_list_aliases": []},
            {"protocol": "tcp", "from_port": 80, "to_port": 80,
             "cidrs": ["0.0.0.0/0"], "ipv6_cidrs": [], "cidr_list_aliases": []},
            {"protocol": "tcp", "from_port": 443, "to_port": 443,
             "cidrs": ["0.0.0.0/0"], "ipv6_cidrs": [], "cidr_list_aliases": []},
        ]
    }
    values["aws_cognito_user_pool.browser"] = {
        "name": "quizforge-production-lightsail",
        "deletion_protection": "ACTIVE",
        "mfa_configuration": "ON",
        "admin_create_user_config": [{"allow_admin_create_user_only": True}],
    }
    values["aws_cognito_user_pool_client.browser"] = {
        "name": "quizforge-production-pkce",
        "generate_secret": False,
        "callback_urls": ["https://quizfromnotes.com/auth/callback"],
        "logout_urls": ["https://quizfromnotes.com/"],
        "allowed_oauth_flows": ["code"],
    }
    values["aws_cognito_user_pool_domain.browser"] = {"domain": "quizforge-123456789012"}
    values["aws_sns_topic.alerts"] = {"name": "quizforge-production-lightsail-alerts"}
    values["aws_sns_topic_subscription.operator"] = {
        "protocol": "email", "endpoint": SETTINGS.email,
    }
    values["aws_budgets_budget.monthly"] = {
        "name": "quizforge-monthly-account-cost",
        "limit_amount": "20",
        "limit_unit": "USD",
        "budget_type": "COST",
        "time_unit": "MONTHLY",
    }
    values["aws_cloudwatch_metric_alarm.status"] = {
        "alarm_name": "quizforge-production-lightsail-status-failed",
        "namespace": "QuizForge/Host",
        "metric_name": "Healthy",
        "treat_missing_data": "breaching",
        "period": 300,
        "evaluation_periods": 2,
    }
    values["aws_cloudwatch_log_group.recovery"] = {"retention_in_days": 14}
    values["aws_iam_role.recovery"] = {
        "name": "quizforge-production-lightsail-recovery",
        "assume_role_policy": json.dumps({
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Principal": {"Service": "lambda.amazonaws.com"},
                "Action": "sts:AssumeRole",
            }],
        }),
    }
    values["aws_lambda_function.recovery"] = {
        "function_name": "quizforge-production-lightsail-recovery",
        "runtime": "python3.13",
        "handler": "identity_triggers.handler",
        "memory_size": 128,
        "timeout": 5,
    }
    values["aws_iam_policy.host_health"] = {
        "name": "quizforge-production-host-health",
        "policy": json.dumps({
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Action": ["cloudwatch:PutMetricData"],
                "Resource": "*",
                "Condition": {"StringEquals": {"cloudwatch:namespace": "QuizForge/Host"}},
            }],
        }),
    }
    return values


def plan():
    values = after_values()
    changes = []
    configs = []
    for address in sorted(EXPECTED):
        changes.append({
            "address": address,
            "mode": "managed",
            "type": address.split(".")[0],
            "provider_name": PROVIDER_NAME,
            "change": {
                "actions": ["create"],
                "before": None,
                "after": copy.deepcopy(values[address]),
                "after_unknown": {},
            },
        })
        configs.append({
            "address": address,
            "mode": "managed",
            "type": address.split(".")[0],
            "name": address.split(".")[1],
            "expressions": {},
        })
    return {
        "format_version": "1.2",
        "terraform_version": "1.14.7",
        "errored": False,
        "applyable": True,
        "complete": True,
        "variables": {
            "monthly_budget_usd": {"value": 20},
            "alert_email": {"value": SETTINGS.email},
            "ssh_public_key": {"value": SETTINGS.ssh_key},
            "admin_ipv4_cidr": {"value": SETTINGS.admin_cidr},
            "public_signup": {"value": False},
        },
        "prior_state": {"values": {"root_module": {"resources": []}}},
        "configuration": {"root_module": {"resources": configs}},
        "resource_changes": changes,
        "checks": [],
    }


def resource(document, address):
    return next(r for r in document["resource_changes"] if r["address"] == address)


class ReviewTests(unittest.TestCase):
    def refused(self, mutate):
        document = plan()
        mutate(document)
        with self.assertRaises(Refused):
            review_plan(document, SETTINGS)

    def test_exact_initial_plan_passes(self):
        manifest = review_plan(plan(), SETTINGS)
        self.assertEqual(manifest["creates"], 19)
        self.assertEqual(manifest["updates"], 0)
        self.assertEqual(manifest["deletes"], 0)
        self.assertEqual(manifest["monthly_aws_alert_budget_usd"], 20)
        self.assertFalse(manifest["public_signup"])
        self.assertFalse(manifest["dns_changes_requested"])
        raw = json.dumps(manifest)
        for private in (SETTINGS.email, SETTINGS.account, SETTINGS.role,
                        SETTINGS.state_bucket, SETTINGS.ssh_key, SETTINGS.admin_cidr):
            self.assertNotIn(private, raw)

    def test_update_delete_replace_extra_and_missing_are_refused(self):
        for actions in (["update"], ["delete"], ["delete", "create"], ["create", "delete"]):
            with self.subTest(actions=actions):
                self.refused(lambda p, a=actions:
                             p["resource_changes"][0]["change"].update(actions=a))
        self.refused(lambda p: p["resource_changes"].pop())
        self.refused(lambda p: p["resource_changes"].append(copy.deepcopy(p["resource_changes"][0])))
        self.refused(lambda p: p["resource_changes"][0].update(previous_address="aws_instance.old"))

    def test_server_size_open_ssh_and_ipv6_are_refused(self):
        self.refused(lambda p: resource(p, "aws_lightsail_instance.server")["change"]["after"]
                     .update(bundle_id="medium_3_0"))
        def open_ssh(p):
            ports = resource(p, "aws_lightsail_instance_public_ports.server")["change"]["after"]["port_info"]
            next(x for x in ports if x["from_port"] == 22)["cidrs"] = ["0.0.0.0/0"]
        self.refused(open_ssh)
        def ipv6(p):
            ports = resource(p, "aws_lightsail_instance_public_ports.server")["change"]["after"]["port_info"]
            next(x for x in ports if x["from_port"] == 443)["ipv6_cidrs"] = ["::/0"]
        self.refused(ipv6)

    def test_budget_signup_recipient_key_and_cidr_are_refused(self):
        self.refused(lambda p: p["variables"]["monthly_budget_usd"].update(value=21))
        self.refused(lambda p: p["variables"]["public_signup"].update(value=True))
        self.refused(lambda p: p["variables"]["alert_email"].update(value="wrong@example.com"))
        self.refused(lambda p: p["variables"]["ssh_public_key"].update(
            value="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWrong"))
        self.refused(lambda p: p["variables"]["admin_ipv4_cidr"].update(value="192.0.2.11/32"))

    def test_cognito_and_alarm_safety_are_refused(self):
        self.refused(lambda p: resource(p, "aws_cognito_user_pool.browser")["change"]["after"]
                     .update(mfa_configuration="OFF"))
        self.refused(lambda p: resource(p, "aws_cognito_user_pool.browser")["change"]["after"]
                     ["admin_create_user_config"][0].update(allow_admin_create_user_only=False))
        self.refused(lambda p: resource(p, "aws_cognito_user_pool_client.browser")["change"]["after"]
                     .update(generate_secret=True))
        self.refused(lambda p: resource(p, "aws_cloudwatch_metric_alarm.status")["change"]["after"]
                     .update(treat_missing_data="notBreaching"))

    def test_nonempty_state_incomplete_plan_and_modules_are_refused(self):
        self.refused(lambda p: p["prior_state"]["values"]["root_module"]["resources"]
                     .append({"mode": "managed"}))
        self.refused(lambda p: p.update(complete=False))
        self.refused(lambda p: p["configuration"]["root_module"].update(module_calls={"x": {}}))

    def test_private_settings_validation(self):
        with self.assertRaises(Refused):
            Settings(SETTINGS.role, SETTINGS.state_bucket, SETTINGS.email,
                     SETTINGS.ssh_key, "0.0.0.0/0")
        with self.assertRaises(Refused):
            Settings(SETTINGS.role, SETTINGS.state_bucket, SETTINGS.email,
                     "not-a-key", SETTINGS.admin_cidr)

    def test_pinned_source_blobs_match_branch(self):
        check_source(Path.cwd())


class WorkflowTests(unittest.TestCase):
    def test_pr_validation_is_credential_free_and_manual_job_never_applies(self):
        workflow = Path(".github/workflows/lightsail-production-inspect.yml").read_text()
        validation = workflow.split("  validate:\n", 1)[1].split("  inspect:\n", 1)[0]
        self.assertNotIn("id-token: write", validation)
        self.assertNotIn("secrets.", validation)
        self.assertNotIn("pull_request_target", workflow)
        self.assertIn("github.event_name == 'workflow_dispatch'", workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertIn("LIGHTSAIL_SSH_PUBLIC_KEY", workflow)
        self.assertIn("LIGHTSAIL_ADMIN_IPV4_CIDR", workflow)
        self.assertIn("quizforge/lightsail-production/terraform.tfstate", workflow)
        self.assertNotIn("terraform apply", workflow)
        self.assertNotIn("-lock=false", workflow)
        self.assertIn("permanent-lightsail-inspection-summary", workflow)


if __name__ == "__main__":
    unittest.main()
