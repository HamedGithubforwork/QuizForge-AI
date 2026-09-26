from __future__ import annotations

import unittest
from unittest import mock

from scripts.production import cognito_sms_activation as sms


class _Shape:
    def __init__(self, members):
        self.members = {name: object() for name in members}


class _Operation:
    def __init__(self, members):
        self.input_shape = _Shape(members)


class _ServiceModel:
    def __init__(self, operations):
        self.operations = operations

    def operation_model(self, name):
        return _Operation(self.operations[name])


class _Meta:
    def __init__(self, operations):
        self.service_model = _ServiceModel(operations)


class FakeCognito:
    def __init__(self):
        self.meta = _Meta({
            "UpdateUserPool": {
                "UserPoolId",
                "Policies",
                "DeletionProtection",
                "LambdaConfig",
                "AutoVerifiedAttributes",
                "VerificationMessageTemplate",
                "EmailConfiguration",
                "UserAttributeUpdateSettings",
                "MfaConfiguration",
                "AdminCreateUserConfig",
                "AccountRecoverySetting",
                "UserPoolTier",
                "SmsConfiguration",
            },
            "UpdateUserPoolClient": {
                "UserPoolId",
                "ClientId",
                "AllowedOAuthFlows",
                "AllowedOAuthScopes",
                "AllowedOAuthFlowsUserPoolClient",
                "CallbackURLs",
                "LogoutURLs",
                "ExplicitAuthFlows",
                "SupportedIdentityProviders",
                "PreventUserExistenceErrors",
                "EnableTokenRevocation",
                "ReadAttributes",
                "WriteAttributes",
                "AccessTokenValidity",
                "IdTokenValidity",
                "RefreshTokenValidity",
                "TokenValidityUnits",
            },
        })
        self.pool_update = None
        self.mfa_update = None
        self.client_update = None

    def update_user_pool(self, **kwargs):
        self.pool_update = kwargs

    def set_user_pool_mfa_config(self, **kwargs):
        self.mfa_update = kwargs

    def update_user_pool_client(self, **kwargs):
        self.client_update = kwargs


class SmsActivationTests(unittest.TestCase):
    def test_role_trust_and_send_policy_are_least_privilege(self):
        account = "123456789012"
        pool_id = "ca-central-1_Test123"
        ext = sms.external_id(account, pool_id)
        trust = sms.trust_policy(account, sms.pool_arn(account, pool_id), ext)
        statement = trust["Statement"][0]
        self.assertEqual(statement["Principal"], {"Service": "cognito-idp.amazonaws.com"})
        self.assertEqual(statement["Action"], "sts:AssumeRole")
        self.assertEqual(statement["Condition"]["StringEquals"]["aws:SourceAccount"], account)
        self.assertEqual(statement["Condition"]["StringEquals"]["sts:ExternalId"], ext)
        self.assertEqual(
            statement["Condition"]["ArnLike"]["aws:SourceArn"],
            sms.pool_arn(account, pool_id),
        )

        identity = "arn:aws:sms-voice:ca-central-1:123456789012:phone-number/phone-abc123"
        policy = sms.send_policy(identity)
        self.assertEqual(policy["Statement"][0]["Action"], ["sms-voice:SendTextMessage"])
        self.assertEqual(policy["Statement"][0]["Resource"], identity)

    def test_identity_status_requires_same_account_and_sms_capability(self):
        service = mock.Mock()
        service.describe_phone_numbers.return_value = {
            "PhoneNumbers": [{
                "PhoneNumberArn": "arn:aws:sms-voice:ca-central-1:123456789012:phone-number/phone-abc123",
                "NumberCapabilities": ["SMS"],
            }]
        }
        identity = "arn:aws:sms-voice:ca-central-1:123456789012:phone-number/phone-abc123"
        self.assertEqual(
            sms.identity_status(service, identity, "123456789012"),
            {
                "origination_identity_present": True,
                "origination_identity_sms_capable": True,
            },
        )

        with self.assertRaises(sms.Refused):
            sms.identity_status(
                service,
                "arn:aws:sms-voice:ca-central-1:999999999999:phone-number/phone-abc123",
                "123456789012",
            )

    def test_baseline_requires_optional_totp_and_existing_security(self):
        pool = {
            "MfaConfiguration": "OPTIONAL",
            "DeletionProtection": "ACTIVE",
            "AdminCreateUserConfig": {"AllowAdminCreateUserOnly": False},
            "UsernameAttributes": ["email"],
            "Policies": {"PasswordPolicy": {
                "MinimumLength": 8,
                "RequireLowercase": True,
                "RequireUppercase": True,
                "RequireNumbers": True,
                "RequireSymbols": True,
            }},
        }
        mfa = {"SoftwareTokenMfaConfiguration": {"Enabled": True}}
        self.assertTrue(all(sms.baseline_checks(pool, mfa).values()))
        pool["DeletionProtection"] = "INACTIVE"
        self.assertFalse(all(sms.baseline_checks(pool, mfa).values()))

    def test_operation_input_drops_read_only_fields(self):
        client = FakeCognito()
        value = sms.operation_input(
            client,
            "UpdateUserPoolClient",
            {
                "ClientId": "client123",
                "UserPoolId": "ca-central-1_Test123",
                "ReadAttributes": ["email"],
                "CreationDate": "read-only",
                "ClientSecret": "must-not-copy",
            },
        )
        self.assertEqual(
            value,
            {
                "ClientId": "client123",
                "UserPoolId": "ca-central-1_Test123",
                "ReadAttributes": ["email"],
            },
        )

    def test_configuration_preserves_existing_values_and_adds_phone(self):
        cognito = FakeCognito()
        pool = {
            "Policies": {"PasswordPolicy": {"MinimumLength": 8}},
            "DeletionProtection": "ACTIVE",
            "AutoVerifiedAttributes": ["email"],
            "UserAttributeUpdateSettings": {
                "AttributesRequireVerificationBeforeUpdate": ["email"]
            },
            "MfaConfiguration": "OPTIONAL",
            "CreationDate": "read-only",
        }
        client = {
            "AllowedOAuthFlows": ["code"],
            "ReadAttributes": ["email", "email_verified", "sub"],
            "WriteAttributes": ["email"],
            "CreationDate": "read-only",
        }
        identity = "arn:aws:sms-voice:ca-central-1:123456789012:phone-number/phone-abc123"
        sms.configure_pool_and_client(
            cognito,
            "ca-central-1_Test123",
            pool,
            "client123",
            client,
            "arn:aws:iam::123456789012:role/quizforge-production-cognito-sms",
            "external-id",
            identity,
        )

        self.assertEqual(
            set(cognito.pool_update["AutoVerifiedAttributes"]),
            {"email", "phone_number"},
        )
        self.assertEqual(
            set(cognito.pool_update["UserAttributeUpdateSettings"]["AttributesRequireVerificationBeforeUpdate"]),
            {"email", "phone_number"},
        )
        self.assertEqual(
            cognito.pool_update["SmsConfiguration"]["EumsSms"]["OriginationIdentity"],
            identity,
        )
        self.assertNotIn("CreationDate", cognito.pool_update)

        self.assertTrue(cognito.mfa_update["SoftwareTokenMfaConfiguration"]["Enabled"])
        self.assertEqual(cognito.mfa_update["MfaConfiguration"], "OPTIONAL")
        self.assertIn("{####}", cognito.mfa_update["SmsMfaConfiguration"]["SmsAuthenticationMessage"])

        self.assertTrue(
            {"phone_number", "phone_number_verified"}.issubset(
                set(cognito.client_update["ReadAttributes"])
            )
        )
        self.assertIn("phone_number", cognito.client_update["WriteAttributes"])
        self.assertNotIn("CreationDate", cognito.client_update)


if __name__ == "__main__":
    unittest.main()
