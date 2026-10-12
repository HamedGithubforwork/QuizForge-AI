"""Credentialless negative tests for one-time Lambda parity deployment."""
from copy import deepcopy
import os
import unittest
from unittest.mock import patch

from fast_recovery import NEW, POOL, verify_plan, update
from test_fast_auth import pool_state
from test_fast_password import policy

POOL_ID = "ca-central-1_TestPool"


def plan():
    before = {
        **pool_state(False), "password_policy": policy(8),
        "user_attribute_update_settings": [
            {"attributes_require_verification_before_update": ["email"]}],
        "verification_message_template": [{"default_email_option": "CONFIRM_WITH_CODE"}],
        "lambda_config": [],
    }
    after = deepcopy(before)
    after["lambda_config"] = [{"post_confirmation": None}]
    out = {"format_version": "1.2", "resource_drift": [], "resource_changes": [
        {"mode": "managed", "address": POOL, "change": {
            "actions": ["update"], "before": before, "after": after,
            "after_unknown": {"lambda_config": [{"post_confirmation": True}]},
        }}
    ]}
    for name in sorted(NEW):
        after_resource = {"name": "quizforge-integrated-staging-recovery"}
        if name == "aws_lambda_function.recovery":
            after_resource = {
                "function_name": "quizforge-integrated-staging-recovery",
                "runtime": "python3.13", "handler": "identity_triggers.handler",
                "timeout": 5, "memory_size": 128,
            }
        out["resource_changes"].append({"mode": "managed", "address": name, "change": {
            "actions": ["create"], "before": None, "after": after_resource,
        }})
    return out


class GuardedLambdaInstall(unittest.TestCase):
    def test_exact_six_staging_only_changes_pass(self):
        self.assertTrue(verify_plan(plan(), POOL_ID))

    def test_rejects_foreign_pool_unrelated_resource_and_replacements(self):
        bad = plan()
        bad["resource_changes"].append({"mode": "managed", "address": "aws_db_instance.db",
                                        "change": {"actions": ["update"], "before": {}, "after": {}}})
        with self.assertRaises(ValueError):
            verify_plan(bad, POOL_ID)
        for index, value in ((1, ["delete", "create"]), (0, ["delete"]), (0, ["create"])):
            change = plan()
            change["resource_changes"][index]["change"]["actions"] = value
            with self.subTest(index=index, value=value), self.assertRaises(ValueError):
                verify_plan(change, POOL_ID)
        with self.assertRaises(ValueError):
            verify_plan(plan(), "ca-central-1_OtherPool")

    def test_rejects_missing_or_unexpected_resource(self):
        for address in NEW:
            changed = plan()
            changed["resource_changes"] = [
                r for r in changed["resource_changes"] if r["address"] != address]
            with self.subTest(address=address), self.assertRaises(ValueError):
                verify_plan(changed, POOL_ID)

    def test_rejects_auth_weakening_other_triggers_and_output_mutations(self):
        for key, value in (
            ("password_policy", policy(7)),
            ("mfa_configuration", "ON"),
            ("deletion_protection", "ACTIVE"),
            ("lambda_config", [{"pre_authentication": "foreign-trigger"}]),
            ("lambda_config", [{}]),
            ("lambda_config", [{"post_confirmation": None, "pre_authentication": "extra"}]),
            ("id", "ca-central-1_OtherPool"),
        ):
            d = plan()
            d["resource_changes"][0]["change"]["after"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                verify_plan(d, POOL_ID)
        for key, value in (
            ("resource_drift", [{"address": POOL}]),
            ("output_changes", {"staging": {"change": {"actions": ["update"]}}}),
        ):
            d = plan()
            d[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                verify_plan(d, POOL_ID)

    def test_rejects_invalid_lambda_code_and_role(self):
        for field, value in (
            ("function_name", "quizforge-production-lightsail-recovery"),
            ("runtime", "nodejs20.x"),
            ("handler", "unreviewed.handler"),
            ("memory_size", 1024),
            ("timeout", 40),
        ):
            d = plan()
            for change in d["resource_changes"]:
                if change["address"] == "aws_lambda_function.recovery":
                    change["change"]["after"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                verify_plan(d, POOL_ID)

    def test_rejects_action_without_explicit_operator_request(self):
        with patch.dict(os.environ, {"STAGING_AUTH_UPDATE": "frontend"}), (
            patch("fast_recovery.package")
        ) as package, self.assertRaises(ValueError):
            update()
        package.assert_not_called()


if __name__ == "__main__":
    unittest.main()
