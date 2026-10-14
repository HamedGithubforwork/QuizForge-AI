import json
import unittest
from unittest.mock import Mock

from scripts.production.lightsail.google_incident import FUNCTION_ARN, evidence
from scripts.production.lightsail.test_google_provider_readiness import (
    FakeCognito, FakeSts, GOOGLE_ID, SECRET,
)


class IncidentTests(unittest.TestCase):
    def inputs(self):
        cognito = Mock()
        base = FakeCognito(provider=True, allowed=True)
        cognito.list_user_pools.side_effect = base.list_user_pools
        cognito.list_user_pool_clients.side_effect = base.list_user_pool_clients
        cognito.describe_user_pool.return_value = {"UserPool": {
            "AdminCreateUserConfig": {"AllowAdminCreateUserOnly": False},
            "LambdaConfig": {"PreSignUp": FUNCTION_ARN, "PostConfirmation": FUNCTION_ARN},
            "SchemaAttributes": [{"Name": "email", "Mutable": True, "Required": True}],
        }}
        cognito.describe_identity_provider.return_value = {"IdentityProvider": {
            "ProviderDetails": {"client_id": GOOGLE_ID, "client_secret": SECRET},
            "AttributeMapping": {"email": "email", "email_verified": "email_verified"},
        }}
        cognito.describe_user_pool_client.return_value = {"UserPoolClient": {
            "SupportedIdentityProviders": ["COGNITO", "Google"], "WriteAttributes": ["email"],
        }}
        functions = Mock()
        functions.get_function_configuration.return_value = {"FunctionArn": FUNCTION_ARN,
                                                            "Environment": {"Variables": {"secret": SECRET}}}
        logs = Mock()
        logs.filter_log_events.return_value = {"events": [{"message":
            "[ERROR] ValueError: Signup is not allowed for this rehearsal " + SECRET}]}
        return dict(sts=FakeSts(), cognito=cognito, functions=functions, logs=logs,
                    client_id=GOOGLE_ID, secret=SECRET, now=20000)

    def test_attached_guard_and_recent_rejection_are_identified_without_private_data(self):
        args = self.inputs()
        result = evidence(**args)
        self.assertTrue(result["pre_signup_is_recovery_function"])
        self.assertTrue(result["recent_rehearsal_signup_rejection"])
        self.assertTrue(result["log_scan_complete"])
        self.assertTrue(result["google_client_secret_matches"])
        self.assertTrue(all(type(value) is bool for value in result.values()))
        text = json.dumps(result)
        for private in (SECRET, GOOGLE_ID, FUNCTION_ARN):
            self.assertNotIn(private, text)
        self.assertEqual(args["logs"].filter_log_events.call_args.kwargs["startTime"], 5600000)

    def test_secret_mismatch_and_absent_guard(self):
        args = self.inputs()
        args["cognito"].describe_user_pool.return_value = {"UserPool": {"LambdaConfig": {}}}
        args["secret"] = "different-sensitive-secret"
        result = evidence(**args)
        self.assertFalse(result["google_client_secret_matches"])
        self.assertFalse(result["pre_signup_trigger_attached"])
        self.assertFalse(result["public_signup_enabled"])

    def test_pagination_is_bounded_and_does_not_claim_complete_on_truncation(self):
        args = self.inputs()
        args["logs"].filter_log_events.side_effect = [{"nextToken": str(n)} for n in range(10)]
        result = evidence(**args)
        self.assertFalse(result["log_scan_complete"])
        self.assertEqual(args["logs"].filter_log_events.call_count, 10)

    def test_second_page_trigger_rejection(self):
        args = self.inputs()
        args["logs"].filter_log_events.side_effect = [
            {"nextToken": "page-two"},
            {"events": [{"message": "ValueError: Unsupported identity trigger"}]},
        ]
        result = evidence(**args)
        self.assertTrue(result["recent_unsupported_trigger_rejection"])
        self.assertEqual(args["logs"].filter_log_events.call_args.kwargs["nextToken"], "page-two")

    def test_automatic_username_mapping_does_not_hide_correct_required_mappings(self):
        args = self.inputs()
        mapping = args["cognito"].describe_identity_provider.return_value["IdentityProvider"]["AttributeMapping"]
        mapping["username"] = "sub"
        result = evidence(**args)
        self.assertFalse(result["google_mapping_matches"])
        self.assertTrue(result["google_email_mapping_matches"])
        self.assertTrue(result["google_verified_email_mapping_matches"])
        self.assertTrue(result["google_default_username_mapping"])
        self.assertFalse(result["google_unexpected_mapping_present"])
        self.assertTrue(result["email_schema_mutable"])
        self.assertFalse(result["unmapped_required_schema_attribute"])

    def test_unknown_mapping_names_and_required_schema_only_emit_booleans(self):
        args = self.inputs()
        args["cognito"].describe_identity_provider.return_value["IdentityProvider"]["AttributeMapping"][SECRET] = SECRET
        schema = args["cognito"].describe_user_pool.return_value["UserPool"]["SchemaAttributes"]
        schema[0]["Mutable"] = False
        schema.append({"Name": SECRET + "-required", "Required": True})
        result = evidence(**args)
        self.assertTrue(result["google_unexpected_mapping_present"])
        self.assertTrue(result["unmapped_required_schema_attribute"])
        self.assertFalse(result["email_schema_mutable"])
        self.assertNotIn(SECRET, json.dumps(result))

    def test_fail_closed_account_function_and_permissions(self):
        for fault in ("account", "function", "permission"):
            args = self.inputs()
            if fault == "account":
                args["sts"] = FakeSts("unexpected")
            elif fault == "function":
                args["functions"].get_function_configuration.return_value = {"FunctionArn": "other"}
            else:
                args["logs"].filter_log_events.side_effect = RuntimeError(SECRET)
            with self.assertRaises((ValueError, RuntimeError)):
                evidence(**args)


if __name__ == "__main__":
    unittest.main()
