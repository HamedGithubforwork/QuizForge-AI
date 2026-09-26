from __future__ import annotations

import copy
import unittest
from unittest import mock

from scripts.production.lightsail import enable_migrated_user_activation as activation


def plan(before=None, after=None, extra=False):
    before = before or {
        "name": activation.CLIENT_NAME,
        "explicit_auth_flows": activation.BEFORE,
        "prevent_user_existence_errors": "ENABLED",
    }
    after = after or copy.deepcopy(before)
    after["explicit_auth_flows"] = activation.AFTER
    values = [{
        "address": "aws_cognito_user_pool_client.browser",
        "change": {"actions": ["update"], "before": before, "after": after},
    }]
    if extra:
        values.append({
            "address": "aws_cognito_user_pool.browser",
            "change": {"actions": ["update"], "before": {}, "after": {}},
        })
    return {"resource_changes": values}


class MigratedUserActivationTests(unittest.TestCase):
    def test_accepts_only_exact_auth_flow_addition(self):
        self.assertTrue(activation.review_plan(plan()))
        self.assertFalse(activation.review_plan({"resource_changes": []}))
        self.assertFalse(activation.review_plan({
            "resource_changes": [{
                "address": "aws_cognito_user_pool.browser",
                "change": {
                    "actions": ["update"],
                    "before": {"password_policy": [{"minimum_length": 14}]},
                    "after": {"password_policy": [{"minimum_length": 8}]},
                },
            }],
        }))

    def test_rejects_unrelated_or_extra_changes(self):
        with self.assertRaises(ValueError):
            activation.review_plan(plan(extra=True))
        changed = plan()
        changed["resource_changes"][0]["change"]["after"]["prevent_user_existence_errors"] = "LEGACY"
        with self.assertRaises(ValueError):
            activation.review_plan(changed)
        wrong = plan()
        wrong["resource_changes"][0]["change"]["after"]["explicit_auth_flows"] = [
            "ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_CUSTOM_AUTH"
        ]
        with self.assertRaises(ValueError):
            activation.review_plan(wrong)

    def test_live_readback_requires_security_interlocks(self):
        client = mock.Mock()
        client.list_user_pools.return_value = {
            "UserPools": [{"Name": activation.POOL_NAME, "Id": "ca-central-1_Test123"}]
        }
        client.list_user_pool_clients.return_value = {
            "UserPoolClients": [{"ClientName": activation.CLIENT_NAME, "ClientId": "client123"}]
        }
        client.describe_user_pool_client.return_value = {"UserPoolClient": {
            "ExplicitAuthFlows": activation.AFTER,
            "PreventUserExistenceErrors": "ENABLED",
            "EnableTokenRevocation": True,
        }}
        with mock.patch.object(activation.boto3, "client", return_value=client):
            checks = activation.verify_live()
        self.assertTrue(all(checks.values()))


if __name__ == "__main__":
    unittest.main()
