"""Trusted synthetic user setup. Credentials/tokens stay in memory or one secret.

Runs only against the Terraform-created rehearsal pool, never production Auth.
Public signup is closed; admin-created test emails are NOT a delivery test.
"""
import base64
import hashlib
import hmac
import secrets
import struct
import time
from uuid import UUID

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

POOL_NAME = "quizforge-cognito-rehearsal"


def totp(secret, timestamp):
    key = base64.b32decode(secret + "=" * ((-len(secret)) % 8))
    digest = hmac.new(key, struct.pack(">Q", int(timestamp) // 30), hashlib.sha1).digest()
    offset = digest[-1] & 15
    number = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7fffffff
    return f"{number % 1_000_000:06d}"


def expect_error(code, operation, **kwargs):
    try:
        operation(**kwargs)
    except ClientError as error:
        assert error.response["Error"]["Code"] == code, "Unexpected Cognito rejection"
        return
    raise AssertionError("Cognito accepted an operation that must be rejected")


def check_configuration(client, values):
    pool = client.describe_user_pool(UserPoolId=values["cognito_pool"])["UserPool"]
    assert pool["Name"] == POOL_NAME and pool["UserPoolTier"] == "LITE"
    assert pool["MfaConfiguration"] == "ON"
    assert pool["AdminCreateUserConfig"]["AllowAdminCreateUserOnly"]
    assert not pool.get("SmsConfiguration")
    assert pool.get("UserPoolAddOns", {}).get("AdvancedSecurityMode", "OFF") == "OFF"
    assert not pool.get("LambdaConfig")
    policy = pool["Policies"]["PasswordPolicy"]
    assert policy["MinimumLength"] >= 14
    assert all(policy[name] for name in ("RequireLowercase", "RequireUppercase", "RequireNumbers", "RequireSymbols"))
    mfa = client.get_user_pool_mfa_config(UserPoolId=values["cognito_pool"])
    assert mfa["SoftwareTokenMfaConfiguration"]["Enabled"] and mfa["MfaConfiguration"] == "ON"
    app = client.describe_user_pool_client(UserPoolId=values["cognito_pool"],
                                          ClientId=values["cognito_client"])["UserPoolClient"]
    assert not app.get("ClientSecret") and app["EnableTokenRevocation"]
    assert app["PreventUserExistenceErrors"] == "ENABLED"
    assert app["AccessTokenValidity"] == 5 and app["TokenValidityUnits"]["AccessToken"] == "minutes"
    assert set(app["ExplicitAuthFlows"]) == {"ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"}
    print("PASS: Cognito Lite, strong password policy, mandatory TOTP, revocation and user-existence protection; no SMS/advanced-security add-ons")


def create_user(client, values, name, *, verified=True):
    password = "Qf9!" + secrets.token_urlsafe(28)
    client.admin_create_user(UserPoolId=values["cognito_pool"], Username=name, MessageAction="SUPPRESS",
                             UserAttributes=[{"Name": "email", "Value": "synthetic@example.invalid"},
                                             {"Name": "email_verified", "Value": str(verified).lower()}])
    expect_error("InvalidPasswordException", client.admin_set_user_password,
                 UserPoolId=values["cognito_pool"], Username=name, Password="weak", Permanent=True)
    client.admin_set_user_password(UserPoolId=values["cognito_pool"], Username=name,
                                   Password=password, Permanent=True)
    return password


def enroll(client, values, name, password):
    login = client.initiate_auth(ClientId=values["cognito_client"], AuthFlow="USER_PASSWORD_AUTH",
                                 AuthParameters={"USERNAME": name, "PASSWORD": password})
    assert login["ChallengeName"] == "MFA_SETUP" and "AuthenticationResult" not in login
    association = client.associate_software_token(Session=login["Session"])
    secret = association["SecretCode"]
    now = time.time()
    verified = client.verify_software_token(Session=association["Session"], UserCode=totp(secret, now))
    assert verified["Status"] == "SUCCESS"
    completed = client.respond_to_auth_challenge(ClientId=values["cognito_client"], ChallengeName="MFA_SETUP",
                Session=verified["Session"], ChallengeResponses={"USERNAME": name})
    result = completed["AuthenticationResult"]
    user = client.get_user(AccessToken=result["AccessToken"])
    subject = str(UUID(next(a["Value"] for a in user["UserAttributes"] if a["Name"] == "sub")))
    return result, subject, secret, now


def prepare(values):
    assert values["cognito_pool"].startswith("ca-central-1_") and values["session_secret"]
    client = boto3.client("cognito-idp", region_name="ca-central-1",
                          config=Config(connect_timeout=10, read_timeout=20, retries={"max_attempts": 0}))
    check_configuration(client, values)
    expect_error("NotAuthorizedException", client.sign_up, ClientId=values["cognito_client"],
                 Username="public-signup-must-stay-closed", Password="Qf9!" + secrets.token_urlsafe(20))
    sessions = {}
    for name in ("mapped", "unmapped", "unverified"):
        password = create_user(client, values, name, verified=name != "unverified")
        result, subject, secret, enrolled_at = enroll(client, values, name, password)
        if name == "mapped":
            challenge = client.initiate_auth(ClientId=values["cognito_client"], AuthFlow="USER_PASSWORD_AUTH",
                                            AuthParameters={"USERNAME": name, "PASSWORD": password})
            assert challenge["ChallengeName"] == "SOFTWARE_TOKEN_MFA" and "AuthenticationResult" not in challenge
            # Avoid relying on a reused MFA code being accepted in the same time step.
            while int(time.time()) // 30 <= int(enrolled_at) // 30:
                time.sleep(1)
            now = time.time()
            nearby = {totp(secret, now + offset) for offset in (-30, 0, 30)}
            wrong = next(f"{i:06d}" for i in range(4) if f"{i:06d}" not in nearby)
            expect_error("CodeMismatchException", client.respond_to_auth_challenge,
                ClientId=values["cognito_client"], ChallengeName="SOFTWARE_TOKEN_MFA", Session=challenge["Session"],
                ChallengeResponses={"USERNAME": name, "SOFTWARE_TOKEN_MFA_CODE": wrong})
            result = client.respond_to_auth_challenge(ClientId=values["cognito_client"], ChallengeName="SOFTWARE_TOKEN_MFA",
                Session=challenge["Session"], ChallengeResponses={"USERNAME": name,
                    "SOFTWARE_TOKEN_MFA_CODE": totp(secret, time.time())})["AuthenticationResult"]
            client.get_user(AccessToken=result["AccessToken"])
        sessions[name] = {"access_token": result["AccessToken"], "refresh_token": result["RefreshToken"],
                          "id_token": result["IdToken"], "user_id": subject}
    print("PASS: weak passwords, incorrect MFA and public signup rejected; synthetic users enrolled TOTP and real login requires MFA")
    create_user(client, values, "lockout")
    locked = False
    for _ in range(12):
        try:
            client.initiate_auth(ClientId=values["cognito_client"], AuthFlow="USER_PASSWORD_AUTH",
                                 AuthParameters={"USERNAME": "lockout", "PASSWORD": "wrong-password"})
        except ClientError as error:
            assert error.response["Error"]["Code"] == "NotAuthorizedException"
            # Inspect only; never print AWS error strings or any credential payload.
            if "attempts exceeded" in error.response["Error"].get("Message", "").lower():
                locked = True
                break
        else:
            raise AssertionError("Incorrect password authenticated")
    assert locked, "Built-in password lockout was not observed"
    print("PASS: Cognito built-in password-attempt lockout observed for a disposable synthetic user")
    import json
    bundle = {**sessions["mapped"], "provider": "cognito", "client_id": values["cognito_client"],
              "issuer": "https://cognito-idp.ca-central-1.amazonaws.com/" + values["cognito_pool"],
              "unmapped": sessions["unmapped"], "unverified": sessions["unverified"]}
    boto3.client("secretsmanager", region_name="ca-central-1").put_secret_value(
        SecretId=values["session_secret"], SecretString=json.dumps(bundle))
    print("PASS: verified Cognito subjects and temporary sessions stored only in the disposable encrypted secret")
