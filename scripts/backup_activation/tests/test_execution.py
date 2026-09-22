"""Credential-free failure-path tests; all cloud/Terraform operations are fakes."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from scripts.backup_activation.contract import Refused, digest, new_report, review_plan
from scripts.backup_activation.runner import Operations, execute, write_report
from scripts.backup_activation.tests.fixtures import SETTINGS, APIError, plan


class FakeOperations:
    def __init__(self, fail=None):
        self.events = []
        self.fail = fail
        self.counts = {}

    def record(self, name):
        self.events.append(name)
        self.counts[name] = self.counts.get(name, 0) + 1
        if self.fail == (name, self.counts[name]):
            raise APIError("AccessDenied")

    def prepare(self, write=False, include_state=True):
        self.record(f"prepare:{write}:{include_state}")

    def empty_state(self):
        self.record("empty_state")

    def inventory(self):
        self.record("inventory")

    def plan(self):
        self.record("plan")
        return plan()

    def same_saved_plan(self):
        self.record("same_saved_plan")

    def apply(self):
        self.record("apply")

    def verify(self):
        self.record("verify")
        return {"infrastructure_settings_verified": True, "subscription_state": "confirmed",
                "alarm_state": "ALARM", "unattached_policies_verified": True,
                "topic_policy_owner_scope_verified": True}


class ExecutionTests(unittest.TestCase):
    def approval(self):
        return digest(review_plan(plan(), SETTINGS))

    def assert_unverified_gates(self, report):
        for key in ("email_delivery_verified", "actual_aws_restore_tested", "scheduled_backups_verified",
                    "independent_keys_verified", "separate_uploader_recovery_identities_verified",
                    "failure_stale_missing_heartbeat_delivery_verified"):
            self.assertIs(report[key], False, key)
        self.assertIs(report["production_routing_changes_requested"], False)
        self.assertEqual(report["policy_attachments_requested"], 0)

    def test_inspection_never_requests_apply_credentials(self):
        ops, report = FakeOperations(), new_report("inspect")
        execute("inspect", SETTINGS, ops, "", report)
        self.assertEqual(ops.events, ["prepare:False:True", "empty_state", "inventory", "plan"])
        self.assertEqual(report["result"], "inspection_passed_no_apply")
        self.assertEqual(report["review_manifest_sha256"], self.approval())
        self.assertIs(report["apply_attempted"], False)
        self.assert_unverified_gates(report)

    def test_rejected_approval_precedes_any_write_session(self):
        ops, report = FakeOperations(), new_report("activate")
        with self.assertRaisesRegex(Refused, "REVIEWED_MANIFEST_MISMATCH"):
            execute("activate", SETTINGS, ops, "0" * 64, report)
        self.assertNotIn("prepare:True:True", ops.events)
        self.assertNotIn("apply", ops.events)
        self.assertEqual(report["result"], "blocked_no_apply_attempted")

    def test_invalid_mode_makes_no_cloud_calls(self):
        ops, report = FakeOperations(), new_report("destroy")
        with self.assertRaisesRegex(Refused, "MODE_INVALID"):
            execute("destroy", SETTINGS, ops, "", report)
        self.assertEqual(ops.events, [])

    def test_initial_or_recheck_failure_never_applies(self):
        for failure in (("empty_state", 1), ("inventory", 1), ("plan", 1),
                        ("empty_state", 2), ("inventory", 2), ("same_saved_plan", 1),
                        ("prepare:True:True", 1), ("same_saved_plan", 2)):
            with self.subTest(failure=failure):
                ops, report = FakeOperations(failure), new_report("activate")
                with self.assertRaises(APIError):
                    execute("activate", SETTINGS, ops, self.approval(), report)
                self.assertNotIn("apply", ops.events)
                self.assertIs(report["apply_attempted"], False)
                self.assertEqual(report["result"], "blocked_no_apply_attempted")
                self.assert_unverified_gates(report)

    def test_activation_uses_one_plan_one_apply_and_read_only_readback(self):
        ops, report, checkpoints = FakeOperations(), new_report("activate"), []
        execute("activate", SETTINGS, ops, self.approval(), report,
                checkpoint=lambda: checkpoints.append(copy.deepcopy(report)))
        self.assertEqual(ops.counts["plan"], 1)
        self.assertEqual(ops.counts["apply"], 1)
        self.assertEqual(ops.counts["inventory"], 2)
        self.assertEqual(ops.events[-2:], ["prepare:False:False", "verify"])
        before_apply = next(p for p in checkpoints if p["result"] == "apply_in_progress_result_unknown")
        self.assertIs(before_apply["apply_attempted"], True)
        self.assertIs(before_apply["terraform_apply_completed"], False)
        self.assertIs(report["terraform_apply_completed"], True)
        self.assertEqual(report["subscription_state"], "confirmed")
        self.assertEqual(report["result"], "activation_infrastructure_settings_verified")
        self.assert_unverified_gates(report)

    def test_partial_apply_is_not_retried_rolled_back_or_described_as_inactive(self):
        ops, report = FakeOperations(("apply", 1)), new_report("activate")
        with self.assertRaises(APIError):
            execute("activate", SETTINGS, ops, self.approval(), report)
        self.assertEqual(ops.counts["apply"], 1)
        self.assertEqual(report["result"], "apply_failed_possible_partial_resources")
        self.assertIs(report["apply_attempted"], True)
        self.assertIs(report["terraform_apply_completed"], False)
        self.assertIs(report["infrastructure_settings_verified"], False)
        self.assertNotIn("verify", ops.events)
        self.assert_unverified_gates(report)

    def test_apply_success_then_readback_failure_preserves_apply_fact(self):
        for failure in (("prepare:False:False", 1), ("verify", 1)):
            with self.subTest(failure=failure):
                ops, report = FakeOperations(failure), new_report("activate")
                with self.assertRaises(APIError):
                    execute("activate", SETTINGS, ops, self.approval(), report)
                self.assertIs(report["terraform_apply_completed"], True)
                self.assertIs(report["infrastructure_settings_verified"], False)
                self.assertEqual(report["result"], "apply_completed_readback_not_verified")
                self.assert_unverified_gates(report)

    def test_verify_has_no_backend_plan_apply_or_publish(self):
        ops, report = FakeOperations(), new_report("verify")
        execute("verify", SETTINGS, ops, "", report)
        self.assertEqual(ops.events, ["prepare:False:False", "verify"])
        self.assertIs(report["terraform_apply_completed"], False)
        self.assertEqual(report["result"], "existing_infrastructure_settings_verified")
        self.assert_unverified_gates(report)

    def test_raw_failure_text_does_not_enter_report(self):
        ops, report = FakeOperations(("apply", 1)), new_report("activate")
        with self.assertRaises(APIError):
            execute("activate", SETTINGS, ops, self.approval(), report)
        public = json.dumps(report)
        for value in (SETTINGS.email, SETTINGS.account, SETTINGS.role, SETTINGS.state_bucket):
            self.assertNotIn(value, public)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "summary.json"
            write_report(output, report, SETTINGS)
            self.assertEqual(json.loads(output.read_text()), report)
            report["unexpected_private_value"] = SETTINGS.email
            with self.assertRaisesRegex(Refused, "PUBLIC_SUMMARY_REDACTION_FAILED"):
                write_report(output, report, SETTINGS)
            self.assertNotIn(SETTINGS.email, output.read_text())


class SavedBinaryTests(unittest.TestCase):
    def test_changed_or_expired_binary_is_rejected_without_terraform(self):
        with tempfile.TemporaryDirectory() as directory:
            ops = Operations.__new__(Operations)
            ops.plan_path = Path(directory) / "synthetic.tfplan"
            ops.plan_path.write_bytes(b"synthetic-saved-binary")
            ops.plan_hash = hashlib.sha256(ops.plan_path.read_bytes()).hexdigest()
            ops.plan_started = time.monotonic()
            ops.candidate = ops.work = Path(directory)
            ops.lock_hash = hashlib.sha256(b"synthetic-lock").hexdigest()
            (ops.work / ".terraform.lock.hcl").write_bytes(b"synthetic-lock")
            with patch("scripts.backup_activation.runner.check_source"), patch("scripts.backup_activation.runner.check_tree"):
                ops.same_saved_plan()
                ops.plan_path.write_bytes(b"different-binary")
                with self.assertRaisesRegex(Refused, "SAVED_PLAN_CHANGED"):
                    ops.same_saved_plan()
                ops.plan_path.write_bytes(b"synthetic-saved-binary")
                ops.plan_started = time.monotonic() - 901
                with self.assertRaisesRegex(Refused, "SAVED_PLAN_EXPIRED"):
                    ops.same_saved_plan()
                ops.plan_started = time.monotonic()
                (ops.work / ".terraform.lock.hcl").write_bytes(b"different-lock")
                with self.assertRaisesRegex(Refused, "PROVIDER_LOCK_CHANGED"):
                    ops.same_saved_plan()


if __name__ == "__main__":
    unittest.main()
