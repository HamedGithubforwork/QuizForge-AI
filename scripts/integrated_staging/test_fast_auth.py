"""No-cloud regression tests for the targeted staging Cognito quick update."""
from copy import deepcopy
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import control
from fast_auth import POOL_ADDRESS, verify_plan, enable

POOL = "ca-central-1_TestPool"


def pool_state(enabled):
    return {
        "id": POOL, "name": "quizforge-integrated-staging",
        "username_attributes": ["email"],
        "auto_verified_attributes": ["email"],
        "admin_create_user_config": [{"allow_admin_create_user_only": not enabled}],
        "mfa_configuration": "OPTIONAL",
        "software_token_mfa_configuration": [{"enabled": True}],
        "deletion_protection": "INACTIVE",
        "email_configuration": [{"email_sending_account": "COGNITO_DEFAULT"}],
        "account_recovery_setting": [{"recovery_mechanism": [{"name": "verified_email", "priority": 1}]}],
    }


def synthetic_plan():
    return {
        "format_version": "1.2",
        "resource_changes": [{
            "address": POOL_ADDRESS, "mode": "managed", "type": "aws_cognito_user_pool",
            "name": "browser",
            "change": {"actions": ["update"], "before": pool_state(False), "after": pool_state(True)},
        }],
        "resource_drift": [],
    }


class GuardedAuthPlan(unittest.TestCase):
    def test_single_in_place_temporary_signup_change_is_permitted(self):
        self.assertTrue(verify_plan(synthetic_plan(), POOL))

    def test_refuses_any_foreign_write_destroy_or_replacement(self):
        for address, actions in (
            ("aws_cognito_user_pool.production", ["update"]),
            ("aws_db_instance.db", ["update"]),
            ("aws_ecs_service.app[\"api\"]", ["update"]),
            (POOL_ADDRESS, ["delete", "create"]),
            (POOL_ADDRESS, ["delete"]),
            (POOL_ADDRESS, ["create"]),
        ):
            with self.subTest(address=address, actions=actions):
                x = synthetic_plan()
                x["resource_changes"][0]["address"] = address
                x["resource_changes"][0]["change"]["actions"] = actions
                with self.assertRaises(ValueError):
                    verify_plan(x, POOL)

    def test_refuses_any_additional_resource_write(self):
        x = synthetic_plan()
        x["resource_changes"].append({
            "mode": "managed", "address": "aws_route53_record.api",
            "change": {"actions": ["update"], "before": {}, "after": {}},
        })
        with self.assertRaises(ValueError):
            verify_plan(x, POOL)

    def test_refuses_external_cognito_pool_or_wrong_identity(self):
        for target in ("us-east-1_TestPool", "ca-central-1_Other"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                verify_plan(synthetic_plan(), target)

    def test_refuses_policy_weakening_or_unrelated_pool_mutations(self):
        for key, value in (
            ("mfa_configuration", "OFF"),
            ("software_token_mfa_configuration", [{"enabled": False}]),
            ("name", "production"),
            ("deletion_protection", "ACTIVE"),
            ("password_policy", [{"minimum_length": 1}]),
            ("username_attributes", ["phone_number"]),
            ("auto_verified_attributes", []),
            ("admin_create_user_config", [{"allow_admin_create_user_only": True}]),
        ):
            with self.subTest(key=key), self.assertRaises(ValueError):
                x = synthetic_plan()
                x["resource_changes"][0]["change"]["after"][key] = value
                verify_plan(x, POOL)

    def test_refuses_unchanged_plan_wrong_actions_drift_and_changed_outputs(self):
        for action in ("no change", "unapproved drift", "output change"):
            with self.subTest(action=action), self.assertRaises(ValueError):
                x = synthetic_plan()
                if action == "no change":
                    x["resource_changes"][0]["change"]["actions"] = ["no-op"]
                elif action == "unapproved drift":
                    x["resource_drift"] = [{"address": "aws_cognito_user_pool.browser"}]
                else:
                    x["output_changes"] = {"integration": {"change": {"actions": ["update"]}}}
                verify_plan(x, POOL)

    def test_refuses_explicit_action_absence_before_cloud_calls(self):
        with patch.dict(os.environ, {"STAGING_AUTH_UPDATE": "frontend"}), (
            patch("fast_auth.fast_frontend.live")
        ) as live, self.assertRaises(ValueError):
            enable()
            live.assert_not_called()

    def test_auth_check_blocks_signup_mismatch_immediately_after_provisioning(self):
        for requested, actual in (("true", True), ("false", False)):
            with patch.dict(os.environ, {"STAGING_SELF_SIGNUP": requested}), (
                patch("control.values", return_value={"pool": POOL})
            ), patch("control.signup_policy", return_value=actual) as policy:
                control.check_auth()
                policy.assert_called_once_with({"pool": POOL})
        for requested, actual in (("true", False), ("false", True)):
            with patch.dict(os.environ, {"STAGING_SELF_SIGNUP": requested}), (
                patch("control.values", return_value={"pool": POOL})
            ), patch("control.signup_policy", return_value=actual), self.assertRaises(ValueError):
                control.check_auth()

    def test_living_approved_modes_require_email_confirmation_and_mfa(self):
        verified = {
            "Name": "quizforge-integrated-staging", "UserPoolTier": "LITE",
            "MfaConfiguration": "OPTIONAL",
            "AccountRecoverySetting": {"RecoveryMechanisms": [{"Name": "verified_email", "Priority": 1}]},
            "AutoVerifiedAttributes": ["email"],
            "EmailConfiguration": {"EmailSendingAccount": "COGNITO_DEFAULT"},
            "AdminCreateUserConfig": {"AllowAdminCreateUserOnly": True},
        }
        values = {"pool": POOL}
        with patch("control.client") as aws:
            # DescribeUserPool does not include configured TOTP factors.
            aws.return_value.get_user_pool_mfa_config.return_value = {
                "MfaConfiguration": "OPTIONAL", "SoftwareTokenMfaConfiguration": {"Enabled": True},
            }
            aws.return_value.describe_user_pool.return_value = {"UserPool": verified}
            self.assertFalse(control.signup_policy(values))
            aws.return_value.get_user_pool_mfa_config.assert_called_with(UserPoolId=POOL)
            new = {**verified, "AdminCreateUserConfig": {"AllowAdminCreateUserOnly": False}}
            aws.return_value.describe_user_pool.return_value = {"UserPool": new}
            self.assertTrue(control.signup_policy(values))
            for altered in (
                {**new, "MfaConfiguration": "OFF"},
                {**new, "AutoVerifiedAttributes": []},
                {**new, "AccountRecoverySetting": {"RecoveryMechanisms": []}},
                {**new, "AdminCreateUserConfig": {"AllowAdminCreateUserOnly": "false"}},
            ):
                aws.return_value.describe_user_pool.return_value = {"UserPool": altered}
                with self.assertRaises(ValueError):
                    control.signup_policy(values)

            aws.return_value.describe_user_pool.return_value = {"UserPool": new}
            for factor in (
                {},
                {"MfaConfiguration": "ON", "SoftwareTokenMfaConfiguration": {"Enabled": True}},
                {"MfaConfiguration": "OPTIONAL"},
                {"MfaConfiguration": "OPTIONAL", "SoftwareTokenMfaConfiguration": {"Enabled": False}},
                {"MfaConfiguration": "OPTIONAL", "SoftwareTokenMfaConfiguration": {"Enabled": "true"}},
                {"MfaConfiguration": "OPTIONAL", "SoftwareTokenMfaConfiguration": {"Enabled": True},
                 "SmsMfaConfiguration": {"SmsAuthenticationMessage": "Not allowed"}},
                {"MfaConfiguration": "OPTIONAL", "SoftwareTokenMfaConfiguration": {"Enabled": True},
                 "EmailMfaConfiguration": {"Subject": "Not allowed"}},
            ):
                with self.subTest(mfa_config=factor):
                    aws.return_value.get_user_pool_mfa_config.return_value = factor
                    with self.assertRaises(ValueError):
                        control.signup_policy(values)


if __name__ == "__main__":
    unittest.main()
