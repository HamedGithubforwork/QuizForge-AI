from __future__ import annotations

import copy
import unittest
from unittest import mock

from scripts.production.lightsail import update_password_policy as policy


def plan(before_min=14, after_min=8, extra=False):
    before = {
        "name": policy.POOL_NAME,
        "password_policy": [{
            "minimum_length": before_min,
            "require_lowercase": True,
            "require_uppercase": True,
            "require_numbers": True,
            "require_symbols": True,
            "temporary_password_validity_days": 1,
        }],
        "mfa_configuration": "ON",
    }
    after = copy.deepcopy(before)
    after["password_policy"][0]["minimum_length"] = after_min
    changes = [{
        "address": "aws_cognito_user_pool.browser",
        "change": {"actions": ["update"], "before": before, "after": after},
    }]
    if extra:
        changes.append({
            "address": "aws_lightsail_instance.server",
            "change": {"actions": ["update"], "before": {}, "after": {}},
        })
    return {"resource_changes": changes}


class PasswordPolicyTests(unittest.TestCase):
    def test_accepts_only_fourteen_to_eight(self):
        self.assertTrue(policy.review_plan(plan()))
        self.assertFalse(policy.review_plan({"resource_changes": []}))

    def test_rejects_wrong_direction_or_extra_changes(self):
        with self.assertRaises(ValueError):
            policy.review_plan(plan(before_min=12))
        with self.assertRaises(ValueError):
            policy.review_plan(plan(after_min=10))
        with self.assertRaises(ValueError):
            policy.review_plan(plan(extra=True))
        changed = plan()
        changed["resource_changes"][0]["change"]["after"]["password_policy"][0]["require_symbols"] = False
        with self.assertRaises(ValueError):
            policy.review_plan(changed)

    def test_live_readback_requires_mfa_signup_and_complexity(self):
        pool = {
            "Policies": {"PasswordPolicy": {
                "MinimumLength": 8,
                "RequireLowercase": True,
                "RequireUppercase": True,
                "RequireNumbers": True,
                "RequireSymbols": True,
            }},
            "MfaConfiguration": "ON",
            "DeletionProtection": "ACTIVE",
            "AdminCreateUserConfig": {"AllowAdminCreateUserOnly": False},
        }
        client = mock.Mock()
        client.list_user_pools.return_value = {
            "UserPools": [{"Name": policy.POOL_NAME, "Id": "ca-central-1_Test123"}]
        }
        client.describe_user_pool.return_value = {"UserPool": pool}
        client.get_user_pool_mfa_config.return_value = {
            "SoftwareTokenMfaConfiguration": {"Enabled": True}
        }
        with mock.patch.object(policy.boto3, "client", return_value=client):
            checks = policy.verify_live()
        self.assertTrue(all(checks.values()))


if __name__ == "__main__":
    unittest.main()
