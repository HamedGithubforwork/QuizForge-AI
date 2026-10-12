"""Offline regression tests for an audited, in-place Cognito parity update."""
from copy import deepcopy
import os
from pathlib import Path
import re
import unittest
from unittest.mock import patch

from fast_auth import POOL_ADDRESS
from fast_parity import verify_plan, update
from test_fast_auth import pool_state
from test_fast_password import policy

POOL = "ca-central-1_TestPool"
ROOT = Path(__file__).resolve().parents[2]


def intended_plan(signup=True):
    before = {**pool_state(signup), "password_policy": policy(8)}
    before["mfa_configuration"] = "ON"
    before["account_recovery_setting"][0]["recovery_mechanism"][0]["name"] = "admin_only"
    before["auto_verified_attributes"] = ["email"] if signup else []
    after = deepcopy(before)
    after["mfa_configuration"] = "OPTIONAL"
    after["account_recovery_setting"][0]["recovery_mechanism"][0]["name"] = "verified_email"
    after["auto_verified_attributes"] = ["email"]
    after["user_attribute_update_settings"] = [{"attributes_require_verification_before_update": ["email"]}]
    after["verification_message_template"] = [{"default_email_option": "CONFIRM_WITH_CODE"}]
    return {"format_version": "1.2", "resource_drift": [],
            "resource_changes": [{
                "address": POOL_ADDRESS, "mode": "managed",
                "change": {"actions": ["update"], "before": before, "after": after},
            }]}


class StagingParityGuards(unittest.TestCase):
    def test_plan_is_accepted_in_both_signup_modes(self):
        for signup in (False, True):
            with self.subTest(signup=signup):
                self.assertTrue(verify_plan(intended_plan(signup), POOL, signup=signup))

    def test_refuses_unrelated_resource_writes_and_replacements(self):
        for target, action in (("aws_db_instance.db", ["update"]),
                               ("aws_cognito_user_pool.production", ["update"]),
                               (POOL_ADDRESS, ["delete", "create"]),
                               (POOL_ADDRESS, ["delete"]), (POOL_ADDRESS, ["create"])):
            d = intended_plan()
            d["resource_changes"][0]["address"] = target
            d["resource_changes"][0]["change"]["actions"] = action
            with self.subTest(target=target, action=action), self.assertRaises(ValueError):
                verify_plan(d, POOL, signup=True)
        d = intended_plan()
        d["resource_changes"].append({"mode":"managed","address":"aws_s3_bucket.site",
                                       "change":{"actions":["update"],"before":{},"after":{}}})
        with self.assertRaises(ValueError):
            verify_plan(d, POOL, signup=True)

    def test_refuses_unreviewed_cognito_mutations(self):
        bad = [
            ("before","password_policy",policy(14)),
            ("after","password_policy",policy(6)),
            ("after","mfa_configuration","ON"),
            ("before","mfa_configuration","OFF"),
            ("after","account_recovery_setting", [{"recovery_mechanism":[{"name":"admin_only","priority":1}]}]),
            ("after","auto_verified_attributes", []),
            ("after","admin_create_user_config", [{"allow_admin_create_user_only": True}]),
            ("after","deletion_protection","ACTIVE"),
            ("after","software_token_mfa_configuration",[{"enabled":False}]),
            ("after","user_attribute_update_settings",[]),
            ("after","verification_message_template",[{"default_email_option":"CONFIRM_WITH_LINK"}]),
            ("after","id","ca-central-1_OtherPool"),
            ("after","email_configuration",[{"email_sending_account":"DEVELOPER"}]),
        ]
        for side, field, value in bad:
            with self.subTest(side=side,field=field),self.assertRaises(ValueError):
                d=intended_plan()
                d["resource_changes"][0]["change"][side][field]=value
                verify_plan(d,POOL,signup=True)

    def test_refuses_drift_output_changes_bad_plan_and_unapproved_signup(self):
        cases=["drift","output","no change","wrong signup","missing mandatory change","missing format"]
        for case in cases:
            d=intended_plan()
            if case=="drift": d["resource_drift"]=[{"address":POOL_ADDRESS}]
            if case=="output": d["output_changes"]={"pool":{"change":{"actions":["update"]}}}
            if case=="no change": d["resource_changes"][0]["change"]["actions"]=["no-op"]
            if case=="missing mandatory change":
                d["resource_changes"][0]["change"]["after"]["mfa_configuration"]="ON"
            if case=="missing format": d.pop("format_version")
            with self.subTest(case=case), self.assertRaises(ValueError):
                verify_plan(d,POOL,signup=(case!="wrong signup"))

    def test_live_policy_guard_distinguishes_legacy_and_parity_pools(self):
        import control

        pool = {
            "Name": "quizforge-integrated-staging",
            "UserPoolTier": "LITE",
            "MfaConfiguration": "ON",
            "AdminCreateUserConfig": {"AllowAdminCreateUserOnly": False},
            "AutoVerifiedAttributes": ["email"],
            "EmailConfiguration": {"EmailSendingAccount": "COGNITO_DEFAULT"},
            "AccountRecoverySetting": {
                "RecoveryMechanisms": [{"Name": "admin_only", "Priority": 1}]
            },
        }
        factors = {"MfaConfiguration": "ON",
                   "SoftwareTokenMfaConfiguration": {"Enabled": True}}
        with patch("control.client") as aws:
            aws.return_value.describe_user_pool.return_value = {"UserPool": pool}
            aws.return_value.get_user_pool_mfa_config.return_value = factors
            self.assertTrue(control.signup_policy({"pool": POOL}, legacy_auth=True))
            with self.assertRaises(ValueError):
                control.signup_policy({"pool": POOL})
            newer = deepcopy(pool)
            newer["MfaConfiguration"] = "OPTIONAL"
            newer["AccountRecoverySetting"]["RecoveryMechanisms"][0]["Name"] = "verified_email"
            aws.return_value.describe_user_pool.return_value = {"UserPool": newer}
            aws.return_value.get_user_pool_mfa_config.return_value = {
                **factors, "MfaConfiguration": "OPTIONAL"}
            self.assertTrue(control.signup_policy({"pool": POOL}))
            with self.assertRaises(ValueError):
                control.signup_policy({"pool": POOL}, legacy_auth=True)

    def test_requires_operator_dispatch_before_aws(self):
        with patch.dict(os.environ, {"STAGING_AUTH_UPDATE":"frontend"}), (
            patch("fast_parity.control.values")
        ) as values, self.assertRaises(ValueError):
            update()
        values.assert_not_called()

    def test_production_and_staging_auth_source_parity(self):
        prod=(ROOT/"infra/aws/lightsail-production/auth.tf").read_text()
        stage=(ROOT/"infra/aws/integrated-staging/main.tf").read_text()
        def one(source,regex):
            matches=re.findall(regex,source,re.MULTILINE|re.DOTALL)
            self.assertEqual(len(matches),1,regex)
            return matches[0]
        for key in ("mfa_configuration","auto_verified_attributes"):
            reg=r"(?m)^\s*"+key+r"\s*=\s*([^\r\n#]+)"
            self.assertEqual(one(prod,reg).strip(),one(stage,reg).strip())
        for reg in (
            r"account_recovery_setting\s*\{\s*recovery_mechanism\s*\{\s*name\s*=\s*([^\s]+)",
            r"user_attribute_update_settings\s*\{\s*attributes_require_verification_before_update\s*=\s*([^\r\n]+)",
            r"verification_message_template\s*\{\s*default_email_option\s*=\s*([^\s]+)",
        ):
            self.assertEqual(one(prod,reg),one(stage,reg))


if __name__ == "__main__":
    unittest.main()
