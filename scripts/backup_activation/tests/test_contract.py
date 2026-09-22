from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from scripts.backup_activation.contract import (
    ALARM_ADDRESS, BUCKET_ADDRESS, OWNER_ADDRESS, CONFIRMATION, EXPECTED, STATE_KEY,
    Settings, Refused, trusted_invocation, review_plan, new_report,
)
from scripts.backup_activation.access import resource_policy, state_policy, encode_session_policy, statement
from scripts.backup_activation.tests.fixtures import SETTINGS, environment, plan, resource


class PlanTests(unittest.TestCase):
    def refused(self, mutate):
        document = plan()
        mutate(document)
        with self.assertRaises(Refused):
            review_plan(document, SETTINGS)

    def test_exact_synthetic_initial_plan_and_private_manifest(self):
        manifest = review_plan(plan(), SETTINGS)
        self.assertEqual(manifest["creates"], 13)
        self.assertEqual(set(manifest["resource_contract"]), EXPECTED)
        for secret in (SETTINGS.email, SETTINGS.account, SETTINGS.role, SETTINGS.state_bucket):
            self.assertNotIn(secret, json.dumps(manifest))

    def test_all_non_create_actions_are_refused(self):
        for actions in (["update"], ["delete"], ["no-op"], ["delete", "create"], ["create", "delete"], ["read"]):
            with self.subTest(actions=actions):
                self.refused(lambda p: p["resource_changes"][0]["change"].update(actions=actions))

    def test_missing_extra_duplicate_and_wrong_provider(self):
        self.refused(lambda p: p["resource_changes"].pop())
        self.refused(lambda p: p["resource_changes"].append(copy.deepcopy(p["resource_changes"][0])))
        self.refused(lambda p: p["resource_changes"][0].update(address="aws_instance.not_allowed"))
        self.refused(lambda p: p["resource_changes"][0].update(provider_name="registry.terraform.io/example/aws"))
        self.refused(lambda p: p["resource_changes"].append({"mode": "data", "address": "data.external.side_effect"}))
        self.refused(lambda p: p["configuration"]["root_module"].update(module_calls={"extra": {}}))

    def test_incomplete_errored_deferred_drift_and_failed_checks(self):
        for key, value in (("complete", False), ("applyable", False), ("errored", True),
                           ("format_version", "9.0"), ("terraform_version", "1.15.0"),
                           ("deferred_changes", [{}]), ("resource_drift", [{}]),
                           ("action_invocations", [{}]), ("checks", [{"status": "unknown"}])):
            with self.subTest(key=key):
                self.refused(lambda p: p.update({key: value}))
        self.refused(lambda p: p.update(prior_state={"values": {"root_module": {"resources": [{"mode": "managed"}]}}}))
        self.refused(lambda p: p["resource_changes"][0]["change"].update(importing={"id": "synthetic"}))
        self.refused(lambda p: p["resource_changes"][0].update(previous_address="aws_s3_bucket.old"))

    def test_wrong_recipient_protocol_names_and_region(self):
        self.refused(lambda p: p["variables"]["alert_email"].update(value="wrong@example.invalid"))
        for key, value in (("endpoint", "wrong@example.invalid"), ("protocol", "https"),
                           ("topic_arn", "arn:aws:sns:ca-central-1:123456789012:wrong")):
            self.refused(lambda p: resource(p, OWNER_ADDRESS)["change"]["after"].update({key: value}))
        self.refused(lambda p: resource(p, BUCKET_ADDRESS)["change"]["after"].update(bucket="wrong-bucket"))
        self.refused(lambda p: resource(p, BUCKET_ADDRESS)["change"]["after"].update(region="us-east-1"))

    def test_storage_and_alarm_safety(self):
        mutations = [
            (BUCKET_ADDRESS, "force_destroy", True), (BUCKET_ADDRESS, "acl", "public-read"),
            ("aws_s3_bucket_public_access_block.backups", "block_public_acls", False),
            ("aws_s3_bucket_ownership_controls.backups", "rule", [{"object_ownership": "ObjectWriter"}]),
            ("aws_s3_bucket_versioning.backups", "versioning_configuration", [{"status": "Suspended"}]),
            (ALARM_ADDRESS, "treat_missing_data", "notBreaching"), (ALARM_ADDRESS, "actions_enabled", False),
            (ALARM_ADDRESS, "period", 86400), (ALARM_ADDRESS, "threshold", 0),
            (ALARM_ADDRESS, "statistic", "Average"), (ALARM_ADDRESS, "insufficient_data_actions", ["wrong"]),
            (ALARM_ADDRESS, "dimensions", {"Deployment": "different"}),
        ]
        for address, key, value in mutations:
            with self.subTest(address=address, key=key):
                self.refused(lambda p: resource(p, address)["change"]["after"].update({key: value}))
        self.refused(lambda p: resource(p, "aws_s3_bucket_lifecycle_configuration.backups")["change"]["after"]
                     ["rule"][0]["expiration"][0].update(days=1))
        self.refused(lambda p: resource(p, "aws_s3_bucket_server_side_encryption_configuration.backups")["change"]["after"]
                     ["rule"][0]["apply_server_side_encryption_by_default"][0].update(sse_algorithm="aws:kms"))

    def test_additional_retention_and_encryption_options_are_rejected(self):
        self.refused(lambda p: resource(p, "aws_s3_bucket_lifecycle_configuration.backups")["change"]["after"]
                     ["rule"][0]["expiration"][0].update(date="2026-09-22T00:00:00Z"))
        self.refused(lambda p: resource(p, "aws_s3_bucket_lifecycle_configuration.backups")["change"]["after"]
                     ["rule"][0]["noncurrent_version_expiration"][0].update(newer_noncurrent_versions=1))
        self.refused(lambda p: resource(p, "aws_s3_bucket_lifecycle_configuration.backups")["change"]["after"]
                     ["rule"][1].update(noncurrent_version_expiration=[{"noncurrent_days": 1}]))
        self.refused(lambda p: resource(p, "aws_s3_bucket_server_side_encryption_configuration.backups")["change"]["after"]
                     ["rule"][0]["apply_server_side_encryption_by_default"][0].update(kms_master_key_id="unapproved-key"))

    def test_unknown_boolean_recipient_policy_and_nested_safety(self):
        for address, field in ((BUCKET_ADDRESS, "force_destroy"), (OWNER_ADDRESS, "endpoint"),
                               ("aws_iam_policy.uploader", "policy"), (ALARM_ADDRESS, "treat_missing_data")):
            with self.subTest(field=field):
                self.refused(lambda p: resource(p, address)["change"]["after_unknown"].update({field: True}))
        self.refused(lambda p: resource(p, "aws_s3_bucket_lifecycle_configuration.backups")["change"]["after_unknown"]
                     .update(rule=[{"filter": [{"tag": True}]}, {}]))

    def test_proven_creation_time_resource_links_only(self):
        document = plan()
        owner = resource(document, OWNER_ADDRESS)["change"]
        owner["after"]["topic_arn"] = None
        owner["after_unknown"]["topic_arn"] = True
        alarm = resource(document, ALARM_ADDRESS)["change"]
        alarm["after"]["alarm_actions"] = [None]
        alarm["after_unknown"]["alarm_actions"] = [True]
        review_plan(document, SETTINGS)
        config = next(c for c in document["configuration"]["root_module"]["resources"] if c["address"] == OWNER_ADDRESS)
        config["expressions"]["topic_arn"] = {"references": ["aws_sns_topic.unreviewed.arn"]}
        with self.assertRaises(Refused):
            review_plan(document, SETTINGS)

    def test_policy_expansions_and_missing_protective_statements(self):
        for address in ("aws_iam_policy.uploader", "aws_iam_policy.recovery", "aws_iam_policy.health", "aws_s3_bucket_policy.backups"):
            def add_permission(p):
                after = resource(p, address)["change"]["after"]
                policy = json.loads(after["policy"])
                policy["Statement"].append({"Effect": "Allow", "Action": "*", "Resource": "*"})
                after["policy"] = json.dumps(policy)
            with self.subTest(address=address):
                self.refused(add_permission)
        def remove_condition(p):
            after = resource(p, "aws_s3_bucket_policy.backups")["change"]["after"]
            policy = json.loads(after["policy"])
            policy["Statement"][2].pop("Condition")
            after["policy"] = json.dumps(policy)
        self.refused(remove_condition)


class InvocationTests(unittest.TestCase):
    def test_manual_main_only_and_no_activation_reruns(self):
        trusted_invocation(environment(), "inspect")
        cases = {"GITHUB_EVENT_NAME": "pull_request", "GITHUB_REF": "refs/tags/main",
                 "GITHUB_REPOSITORY": "someone/fork", "GITHUB_WORKFLOW_REF": "other/workflow@refs/heads/main",
                 "GITHUB_WORKFLOW_SHA": "b" * 40, "TF_WORKSPACE": "production", "RUNNER_DEBUG": "1"}
        for key, value in cases.items():
            env = environment()
            env[key] = value
            with self.subTest(key=key), self.assertRaises(Refused):
                trusted_invocation(env, "inspect")
        for mode in ("destroy", "notify", "apply", "inspect; echo unsafe"):
            with self.assertRaises(Refused):
                trusted_invocation(environment(), mode)
        env = environment("activate")
        with self.assertRaises(Refused):
            trusted_invocation(env, "activate")
        env.update(QF_CONFIRMATION=CONFIRMATION, QF_REVIEWED_MANIFEST="b" * 64)
        trusted_invocation(env, "activate")
        env["GITHUB_RUN_ATTEMPT"] = "2"
        with self.assertRaises(Refused):
            trusted_invocation(env, "activate")

    def test_private_settings_validation(self):
        self.assertEqual(Settings.from_env(environment()), SETTINGS)
        for key, value in (("QF_ROLE_ARN", "arn:aws:iam::*:role/wildcard"),
                           ("QF_STATE_BUCKET", "wrong/bucket"), ("AWS_BUDGET_ALERT_EMAIL", "a\nb@example.invalid")):
            env = environment()
            env[key] = value
            with self.assertRaises(Refused):
                Settings.from_env(env)


class SessionPolicyTests(unittest.TestCase):
    def test_exact_resource_session_and_email_condition(self):
        text = resource_policy(SETTINGS, write=True)
        self.assertLessEqual(len(text), 2048)
        document = json.loads(text)
        all_actions = []
        for st in document["Statement"]:
            actions = st["Action"] if isinstance(st["Action"], list) else [st["Action"]]
            all_actions.extend(actions)
            self.assertTrue(all("*" not in action for action in actions))
            if st["Resource"] == "*":
                self.assertEqual(actions, ["sts:GetCallerIdentity"])
            else:
                resources = st["Resource"] if isinstance(st["Resource"], list) else [st["Resource"]]
                self.assertTrue(all("*" not in r and SETTINGS.account in r for r in resources))
        for forbidden in ("sns:Publish", "iam:AttachRolePolicy", "iam:CreateAccessKey", "iam:CreatePolicyVersion",
                          "s3:DeleteBucket", "s3:DeleteObject", "route53:ChangeResourceRecordSets", "cloudwatch:SetAlarmState"):
            self.assertNotIn(forbidden, all_actions)
        subscription = next(st for st in document["Statement"] if st["Action"] == "sns:Subscribe")
        self.assertEqual(subscription["Resource"], SETTINGS.topic)
        self.assertEqual(subscription["Condition"]["StringEquals"], {"sns:Protocol": "email", "sns:Endpoint": SETTINGS.email})

    def test_state_permissions_are_separate_and_delete_is_lock_only(self):
        for write in (False, True):
            document = json.loads(state_policy(SETTINGS, write=write))
            target = f"arn:aws:s3:::{SETTINGS.state_bucket}/{STATE_KEY}"
            for st in document["Statement"]:
                actions = st["Action"] if isinstance(st["Action"], list) else [st["Action"]]
                if "s3:DeleteObject" in actions:
                    self.assertEqual(st["Resource"], target + ".tflock")
                if st["Resource"] == target:
                    self.assertEqual("s3:PutObject" in actions, write)
            self.assertNotIn(SETTINGS.bucket, json.dumps(document))
        self.assertNotIn(SETTINGS.state_bucket, resource_policy(SETTINGS, write=True))

    def test_oversized_policies_never_fall_back_to_unrestricted_access(self):
        with self.assertRaisesRegex(Refused, "SESSION_POLICY_SIZE_EXCEEDED"):
            encode_session_policy([statement("s3:GetObject", "arn:aws:s3:::" + "x" * 2100)])


class WorkflowContractTests(unittest.TestCase):
    def test_pr_is_credential_free_and_cloud_is_secret_routed(self):
        main = Path(".github/workflows/aws-backup-activation.yml").read_text()
        cloud = Path(".github/workflows/aws-backup-activation-cloud.yml").read_text()
        validation = main.split("  validate:\n", 1)[1].split("  backup:\n", 1)[0]
        self.assertNotIn("id-token: write", validation)
        self.assertNotIn("secrets.", validation)
        self.assertNotIn("pull_request_target", main + cloud)
        self.assertIn("default: inspect", main)
        self.assertIn("github.event_name == 'workflow_dispatch'", main)
        self.assertIn("github.ref == 'refs/heads/main'", main)
        self.assertIn("cancel-in-progress: false", cloud)
        self.assertIn("QF_ROLE_ARN: ${{ secrets.QF_ROLE_ARN }}", cloud)
        self.assertIn("QF_STATE_BUCKET: ${{ secrets.QF_STATE_BUCKET }}", cloud)
        self.assertNotIn("${{ vars.", cloud)
        self.assertNotIn("secrets: inherit", main)
        self.assertIn("path: backup-activation-results/summary.json", cloud)
        self.assertNotIn("-lock=false", main + cloud)


if __name__ == "__main__":
    unittest.main()
