from __future__ import annotations

import copy
import unittest
from unittest import mock

from scripts.production.lightsail import enable_public_signup as signup


def plan(before_gate=True, after_gate=False, extra=False):
    before = {
        "name": signup.POOL_NAME,
        "mfa_configuration": "ON",
        "admin_create_user_config": [{"allow_admin_create_user_only": before_gate}],
    }
    after = copy.deepcopy(before)
    after["admin_create_user_config"][0]["allow_admin_create_user_only"] = after_gate
    values = [{
        "address": "aws_cognito_user_pool.browser",
        "change": {"actions": ["update"], "before": before, "after": after},
    }]
    if extra:
        values.append({"address": "aws_lightsail_instance.server",
                       "change": {"actions": ["update"], "before": {}, "after": {}}})
    return {"resource_changes": values}


class PublicSignupTests(unittest.TestCase):
    def test_accepts_only_exact_signup_toggle(self):
        self.assertTrue(signup.review_plan(plan()))
        self.assertFalse(signup.review_plan({"resource_changes": []}))

    def test_rejects_unrelated_or_wrong_direction_changes(self):
        with self.assertRaises(ValueError):
            signup.review_plan(plan(extra=True))
        with self.assertRaises(ValueError):
            signup.review_plan(plan(before_gate=False, after_gate=True))
        changed = plan()
        changed["resource_changes"][0]["change"]["after"]["mfa_configuration"] = "OFF"
        with self.assertRaises(ValueError):
            signup.review_plan(changed)

    def test_live_verification_requires_all_security_interlocks(self):
        pool = {
            "AdminCreateUserConfig": {"AllowAdminCreateUserOnly": False},
            "DeletionProtection": "ACTIVE",
            "UsernameAttributes": ["email"],
            "AutoVerifiedAttributes": ["email"],
            "MfaConfiguration": "ON",
            "SoftwareTokenMfaConfiguration": {"Enabled": True},
            "UserAttributeUpdateSettings": {"AttributesRequireVerificationBeforeUpdate": ["email"]},
            "Policies": {"PasswordPolicy": {
                "MinimumLength": 14, "RequireLowercase": True, "RequireUppercase": True,
                "RequireNumbers": True, "RequireSymbols": True,
            }},
            "EmailConfiguration": {"EmailSendingAccount": "COGNITO_DEFAULT"},
        }
        client = mock.Mock()
        client.list_user_pools.return_value = {"UserPools": [{"Name": signup.POOL_NAME, "Id": "ca-central-1_Test123"}]}
        client.describe_user_pool.return_value = {"UserPool": pool}
        client.get_user_pool_mfa_config.return_value = {"SoftwareTokenMfaConfiguration": {"Enabled": True}}
        with mock.patch.object(signup.boto3, "client", return_value=client):
            checks = signup.verify_live()
        self.assertTrue(all(checks.values()))


if __name__ == "__main__":
    unittest.main()
