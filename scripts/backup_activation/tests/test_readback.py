"""Synthetic AWS responses only: no SDK client, AWS account, or notification."""
from __future__ import annotations

import copy
from io import BytesIO
import json
import unittest

from scripts.backup_activation.contract import Refused, new_report
from scripts.backup_activation.readback import absent, empty_state, inventory, verify, subscription_state
from scripts.backup_activation.tests.fixtures import SETTINGS, APIError, Clients, absent_clients, live_clients


class CollisionAndStateTests(unittest.TestCase):
    def test_only_explicit_absence_is_accepted(self):
        inventory(absent_clients(), SETTINGS)
        for code in ("AccessDenied", "Forbidden", "Throttling", "NoSuchEntity", "503"):
            def fail():
                raise APIError(code)
            with self.subTest(code=code), self.assertRaises(APIError):
                absent(fail, {"NoSuchBucket"})
        with self.assertRaisesRegex(Refused, "NAMED_RESOURCE_COLLISION"):
            absent(lambda: {}, {"NoSuchBucket"})

    def test_each_named_resource_collision_blocks(self):
        cases = (("s3", "get_bucket_versioning", {"Status": "Enabled"}),
                 ("sns", "get_topic_attributes", {"Attributes": {}}),
                 ("iam", "get_policy", {"Policy": {}}),
                 ("cloudwatch", "list_tags_for_resource", {"Tags": []}))
        for service, method, response in cases:
            with self.subTest(service=service):
                clients = absent_clients()
                clients.services[service].responses[method] = response
                with self.assertRaisesRegex(Refused, "NAMED_RESOURCE_COLLISION"):
                    inventory(clients, SETTINGS)
        # The same exact-ARN tag probe is used for a composite alarm collision.
        self.assertEqual(clients.services["cloudwatch"].calls[-1][1], {"ResourceARN": SETTINGS.alarm})
        self.assertNotIn("describe_alarms", [name for name, _ in clients.services["cloudwatch"].calls])

    def state_clients(self, state=None, error=None):
        response = APIError(error) if error else lambda **kwargs: {"Body": BytesIO(json.dumps(state).encode())}
        return Clients({"s3": {"get_bucket_versioning": {"Status": "Enabled"},
                               "get_bucket_location": {"LocationConstraint": "ca-central-1"},
                               "get_object": response}})

    def test_absent_and_empty_state_only(self):
        empty_state(self.state_clients(error="NoSuchKey"), SETTINGS)
        empty_state(self.state_clients({"version": 4, "resources": [], "outputs": {}}), SETTINGS)
        for state in ({"version": 4, "resources": [{"type": "aws_s3_bucket"}]},
                      {"version": 4, "outputs": {"private": {"value": "existing"}}},
                      {"version": 3, "resources": []}):
            with self.subTest(state=state), self.assertRaisesRegex(Refused, "INITIAL_STATE_NOT_EMPTY"):
                empty_state(self.state_clients(state), SETTINGS)
        for code in ("AccessDenied", "NoSuchBucket", "NotFound", "403"):
            with self.subTest(code=code), self.assertRaises(APIError):
                empty_state(self.state_clients(error=code), SETTINGS)

    def test_state_versioning_and_region_are_required(self):
        for method, response in (("get_bucket_versioning", {"Status": "Suspended"}),
                                 ("get_bucket_location", {"LocationConstraint": "us-east-1"})):
            clients = self.state_clients(error="NoSuchKey")
            clients.services["s3"].responses[method] = response
            with self.subTest(method=method), self.assertRaises(Refused):
                empty_state(clients, SETTINGS)


class ReadbackTests(unittest.TestCase):
    def test_pending_and_confirmed_are_never_delivery_or_restore_proof(self):
        for status in ("pending", "confirmed"):
            with self.subTest(status=status):
                clients = live_clients(status)
                report = new_report("verify")
                report.update(verify(clients, SETTINGS))
                self.assertIs(report["infrastructure_settings_verified"], True)
                self.assertEqual(report["subscription_state"], status)
                self.assertEqual(report["alarm_state"], "ALARM")
                self.assertIs(report["email_delivery_verified"], False)
                self.assertIs(report["actual_aws_restore_tested"], False)
                self.assertIs(report["scheduled_backups_verified"], False)
                self.assertIs(report["terraform_apply_completed"], False)
                methods = [method for service in clients.services.values() for method, _ in service.calls]
                self.assertFalse(any(method.startswith(("put_", "create_", "delete_", "publish", "subscribe"))
                                     for method in methods))
                for method, kwargs in clients.services["s3"].calls:
                    self.assertEqual(kwargs["Bucket"], SETTINGS.bucket)
                    self.assertEqual(kwargs["ExpectedBucketOwner"], SETTINGS.account)

    def test_changed_storage_safety_is_rejected(self):
        mutations = (
            ("get_public_access_block", lambda x: x["PublicAccessBlockConfiguration"].update(BlockPublicPolicy=False)),
            ("get_bucket_ownership_controls", lambda x: x["OwnershipControls"]["Rules"][0].update(ObjectOwnership="ObjectWriter")),
            ("get_bucket_versioning", lambda x: x.update(Status="Suspended")),
            ("get_bucket_encryption", lambda x: x["ServerSideEncryptionConfiguration"]["Rules"][0]
             ["ApplyServerSideEncryptionByDefault"].update(SSEAlgorithm="aws:kms")),
            ("get_bucket_lifecycle_configuration", lambda x: x["Rules"][0]["Expiration"].update(Days=1)),
            ("get_bucket_lifecycle_configuration", lambda x: x["Rules"][1].update(Status="Disabled")),
            ("get_bucket_policy_status", lambda x: x["PolicyStatus"].update(IsPublic=True)),
            ("get_bucket_acl", lambda x: x["Grants"].append({"Permission": "READ", "Grantee": {"Type": "Group"}})),
        )
        for method, change in mutations:
            with self.subTest(method=method):
                clients = live_clients()
                change(clients.services["s3"].responses[method])
                with self.assertRaises(Refused):
                    verify(clients, SETTINGS)

    def test_bucket_policy_expansion_and_topic_owner_mismatch_are_rejected(self):
        clients = live_clients()
        value = clients.services["s3"].responses["get_bucket_policy"]
        policy = json.loads(value["Policy"])
        policy["Statement"].pop()
        value["Policy"] = json.dumps(policy)
        with self.assertRaisesRegex(Refused, "BUCKET_POLICY_MISMATCH"):
            verify(clients, SETTINGS)
        clients = live_clients()
        value = clients.services["sns"].responses["get_topic_attributes"]["Attributes"]
        policy = json.loads(value["Policy"])
        policy["Statement"][0]["Condition"]["StringEquals"]["AWS:SourceOwner"] = "999999999999"
        value["Policy"] = json.dumps(policy)
        with self.assertRaisesRegex(Refused, "UNSAFE_TOPIC_POLICY"):
            verify(clients, SETTINGS)

    def test_attached_or_modified_iam_policy_is_rejected(self):
        for changed in ({"AttachmentCount": 1}, {"PermissionsBoundaryUsageCount": 1},
                        {"DefaultVersionId": "v2"}, {"Arn": "wrong-policy"}):
            with self.subTest(changed=changed):
                clients = live_clients()
                original = clients.services["iam"].responses["get_policy"]
                def altered(**kwargs):
                    value = original(**kwargs)
                    value["Policy"].update(changed)
                    return value
                clients.services["iam"].responses["get_policy"] = altered
                with self.assertRaises(Refused):
                    verify(clients, SETTINGS)

    def test_wrong_extra_absent_or_paginated_subscriber_is_rejected(self):
        for mutation in (lambda rows: rows[0].update(Endpoint="wrong@example.invalid"),
                         lambda rows: rows[0].update(Protocol="https"),
                         lambda rows: rows[0].update(TopicArn=SETTINGS.topic + "-wrong"),
                         lambda rows: rows[0].update(Owner="999999999999"),
                         lambda rows: rows.append(copy.deepcopy(rows[0])),
                         lambda rows: rows.clear()):
            clients = live_clients()
            mutation(clients.services["sns"].responses["list_subscriptions_by_topic"]["Subscriptions"])
            with self.assertRaises(Refused):
                subscription_state(clients.client("sns"), SETTINGS)
        clients = live_clients()
        clients.services["sns"].responses["list_subscriptions_by_topic"] = {"Subscriptions": [], "NextToken": "loop"}
        with self.assertRaisesRegex(Refused, "SUBSCRIPTION_PAGINATION_LIMIT"):
            subscription_state(clients.client("sns"), SETTINGS)

    def test_pending_returned_arn_and_confirmation_attributes_are_checked(self):
        clients = live_clients("confirmed")
        attrs = clients.services["sns"].responses["get_subscription_attributes"]["Attributes"]
        attrs["PendingConfirmation"] = "true"
        self.assertEqual(subscription_state(clients.client("sns"), SETTINGS), "pending")
        attrs["PendingConfirmation"] = "unknown"
        with self.assertRaisesRegex(Refused, "SUBSCRIPTION_CONFIRMATION_UNKNOWN"):
            subscription_state(clients.client("sns"), SETTINGS)
        attrs["PendingConfirmation"] = "false"
        attrs["FilterPolicy"] = '{"unreviewed":["filter"]}'
        with self.assertRaisesRegex(Refused, "SUBSCRIPTION_FILTER_PRESENT"):
            subscription_state(clients.client("sns"), SETTINGS)

    def test_alarm_targets_missing_data_or_actions_cannot_drift(self):
        for change in ({"AlarmActions": [SETTINGS.topic + "-other"]}, {"OKActions": []},
                       {"TreatMissingData": "notBreaching"}, {"ActionsEnabled": False},
                       {"Period": 86400}, {"Statistic": "Average"},
                       {"Dimensions": [{"Name": "Deployment", "Value": "other"}]}):
            clients = live_clients()
            clients.services["cloudwatch"].responses["describe_alarms"]["MetricAlarms"][0].update(change)
            with self.subTest(change=change), self.assertRaises(Refused):
                verify(clients, SETTINGS)


if __name__ == "__main__":
    unittest.main()
