from __future__ import annotations

import copy
import unittest
from unittest import mock

from scripts.production.lightsail import update_mfa_policy as policy


def plan(before_mfa="ON", after_mfa="OPTIONAL", extra=False):
    before = {
        "name": policy.POOL_NAME,
        "mfa_configuration": before_mfa,
        "software_token_mfa_configuration": [{"enabled": True}],
        "password_policy": [{
            "minimum_length": 8,
            "require_lowercase": True,
            "require_uppercase": True,
            "require_numbers": True,
            "require_symbols": True,
        }],
    }
    after = copy.deepcopy(before)
    after["mfa_configuration"] = after_mfa
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


class MfaPolicyTests(unittest.TestCase):
    def test_accepts_only_required_to_optional(self):
        self.assertTrue(policy.review_plan(plan()))
        self.assertFalse(policy.review_plan({"resource_changes": []}))

    def test_rejects_wrong_direction_or_extra_changes(self):
        with self.assertRaises(ValueError):
            policy.review_plan(plan(before_mfa="OPTIONAL"))
        with self.assertRaises(ValueError):
            policy.review_plan(plan(after_mfa="OFF"))
        with self.assertRaises(ValueError):
            policy.review_plan(plan(extra=True))
        changed = plan()
        changed["resource_changes"][0]["change"]["after"]["password_policy"][0]["minimum_length"] = 10
        with self.assertRaises(ValueError):
            policy.review_plan(changed)

    def test_live_readback_requires_optional_mfa_and_security_baseline(self):
        pool = {
            "MfaConfiguration": "OPTIONAL",
            "Policies": {"PasswordPolicy": {
                "MinimumLength": 8,
                "RequireLowercase": True,
                "RequireUppercase": True,
                "RequireNumbers": True,
                "RequireSymbols": True,
            }},
            "DeletionProtection": "ACTIVE",
            "AdminCreateUserConfig": {"AllowAdminCreateUserOnly": False},
            "UsernameAttributes": ["email"],
            "AutoVerifiedAttributes": ["email"],
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
