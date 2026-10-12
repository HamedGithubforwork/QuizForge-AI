"""Cognito password parity and password-only Quick Update safety tests."""
import os
from pathlib import Path
import re
import unittest
from unittest.mock import patch

from fast_password import verify_password_plan, update, live_minimum
from fast_auth import POOL_ADDRESS
from test_fast_auth import pool_state

POOL = "ca-central-1_TestPool"
ROOT = Path(__file__).resolve().parents[2]


def policy(minimum):
    return [{
        "minimum_length": minimum,
        "require_lowercase": True,
        "require_uppercase": True,
        "require_numbers": True,
        "require_symbols": True,
        "temporary_password_validity_days": 1,
    }]


def plan(signup=True):
    before = {**pool_state(signup), "password_policy": policy(14)}
    after = {**pool_state(signup), "password_policy": policy(8)}
    return {
        "format_version": "1.2",
        "resource_drift": [],
        "resource_changes": [{
            "mode": "managed",
            "address": POOL_ADDRESS,
            "change": {"actions": ["update"], "before": before, "after": after},
        }],
    }


class PasswordPolicyParity(unittest.TestCase):
    def test_staging_and_production_password_rules_are_identical(self):
        production = (ROOT / "infra/aws/lightsail-production/auth.tf").read_text()
        staging = (ROOT / "infra/aws/integrated-staging/main.tf").read_text()
        def policies(source):
            blocks = re.findall(r"password_policy\s*\{([^}]*)\}", source)
            self.assertEqual(len(blocks), 1)
            return dict(re.findall(r"(?m)^\s*(\w+)\s*=\s*([^\s#]+)", blocks[0]))
        p, s = policies(production), policies(staging)
        self.assertEqual(p, s)
        self.assertEqual(p["minimum_length"], "8")
        self.assertEqual([p[k] for k in (
            "require_lowercase", "require_uppercase", "require_numbers", "require_symbols"
        )], ["true"] * 4)

    def test_reviewed_plan_accepts_both_signup_modes(self):
        for signup in (False, True):
            with self.subTest(signup=signup):
                self.assertTrue(verify_password_plan(plan(signup), POOL, signup=signup))

    def test_rejects_other_resource_changes_and_replacements(self):
        for address, actions in (
            (POOL_ADDRESS, ["delete", "create"]),
            ("aws_cognito_user_pool.production", ["update"]),
            ("aws_ecs_service.app[\"api\"]", ["update"]),
            ("aws_db_instance.db", ["update"]),
        ):
            with self.subTest(address=address, actions=actions), self.assertRaises(ValueError):
                value = plan()
                change = value["resource_changes"][0]
                change["address"] = address
                change["change"]["actions"] = actions
                verify_password_plan(value, POOL, signup=True)
        extra = plan()
        extra["resource_changes"].append({
            "mode": "managed", "address": "aws_s3_bucket.site",
            "change": {"actions": ["update"], "before": {}, "after": {}},
        })
        with self.assertRaises(ValueError):
            verify_password_plan(extra, POOL, signup=True)

    def test_rejects_weak_password_requirements_or_mfa_changes(self):
        for bad in (
            ("after", "password_policy", policy(6)),
            ("after", "password_policy", policy(10)),
            ("after", "password_policy", [{**policy(8)[0], "require_symbols": False}]),
            ("after", "mfa_configuration", "OPTIONAL"),
            ("after", "auto_verified_attributes", []),
            ("after", "username_attributes", ["phone_number"]),
            ("before", "password_policy", policy(8)),
            ("after", "password_policy", [{**policy(8)[0], "temporary_password_validity_days": 2}]),
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                side, key, value = bad
                document = plan()
                document["resource_changes"][0]["change"][side][key] = value
                verify_password_plan(document, POOL, signup=True)

    def test_rejects_bad_pool_drift_unknown_action_output_or_wrong_signup(self):
        for mutation in ("wrong pool", "drift", "no action", "output", "wrong signup", "extra policy field"):
            document = plan()
            if mutation == "wrong pool":
                document["resource_changes"][0]["change"]["after"]["id"] = "ca-central-1_OtherPool"
            elif mutation == "drift":
                document["resource_drift"] = [{"address": POOL_ADDRESS}]
            elif mutation == "no action":
                document["resource_changes"][0]["change"]["actions"] = ["no-op"]
            elif mutation == "output":
                document["output_changes"] = {"stack": {"change": {"actions": ["update"]}}}
            elif mutation == "extra policy field":
                document["resource_changes"][0]["change"]["after"]["password_policy"][0]["unknown"] = "changed"
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                verify_password_plan(document, POOL, signup=mutation == "wrong signup" and False or True)
                # wrong-signup case expects False; all others expect True.

    def test_requires_manual_operation_before_any_aws_call(self):
        with patch.dict(os.environ, {"STAGING_AUTH_UPDATE": "frontend"}), (
            patch("fast_password.fast_frontend.live")
        ) as live, self.assertRaises(ValueError):
            update()
        live.assert_not_called()

    def test_live_cognito_policy_reads_actual_aws_account(self):
        valid = {"Name": "quizforge-integrated-staging", "Policies": {"PasswordPolicy": {
            "MinimumLength": 14, "RequireLowercase": True, "RequireUppercase": True,
            "RequireNumbers": True, "RequireSymbols": True, "TemporaryPasswordValidityDays": 1
        }}}
        with patch("fast_password.control.client") as client:
            client.return_value.describe_user_pool.return_value = {"UserPool": valid}
            self.assertEqual(live_minimum(POOL), 14)
            client.return_value.describe_user_pool.return_value = {
                "UserPool": {**valid, "Policies": {
                    "PasswordPolicy": {**valid["Policies"]["PasswordPolicy"], "MinimumLength": 8}
                }}
            }
            self.assertEqual(live_minimum(POOL), 8)
            client.return_value.describe_user_pool.return_value = {
                "UserPool": {**valid, "Policies": {
                    "PasswordPolicy": {**valid["Policies"]["PasswordPolicy"], "RequireUppercase": False}
                }}
            }
            with self.assertRaises(ValueError):
                live_minimum(POOL)


if __name__ == "__main__":
    unittest.main()
