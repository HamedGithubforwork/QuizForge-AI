"""Disposable recovery probe; secrets stay in memory or temporary SecureStrings."""
from datetime import datetime, timezone
import json
import os
import re
import secrets
import time

import boto3
from botocore.exceptions import ClientError

import control

PREFIX = "/quizforge/cognito-browser-rehearsal/recovery/"
PARAMETERS = [PREFIX + name for name in ("fixture", "refresh")]


def ssm():
    return boto3.client("ssm", region_name="ca-central-1")


def empty():
    assert not ssm().get_parameters(Names=PARAMETERS, WithDecryption=False)["Parameters"], "Recovery fixture still exists; run stop"


def cleanup():
    # Exact isolated names only; also handles a partially written fixture.
    ssm().delete_parameters(Names=PARAMETERS)
    empty()
    print("PASS: both temporary recovery SecureStrings are absent")


def save(fixture, refresh):
    empty()
    for name, value in zip(PARAMETERS, (json.dumps(fixture), refresh)):
        assert len(value.encode()) <= 4096
        ssm().put_parameter(Name=name, Value=value, Type="SecureString", Tier="Standard", Overwrite=False,
                            Tags=[{"Key": "Project", "Value": "QuizForge-AI"}, {"Key": "Temporary", "Value": "true"}])


def rejected(operation, codes, **args):
    try:
        operation(**args)
    except ClientError as error:
        assert error.response["Error"]["Code"] in codes, "Unexpected rejection category"
    else:
        raise AssertionError("A forbidden recovery operation succeeded")


def live_state(v):
    assert v and v.get("recovery_run", "").isdigit(), "No recovery run in isolated state"
    assert datetime.now(timezone.utc) < datetime.fromisoformat(v["deadline"].replace("Z", "+00:00")), "Recovery window expired"


def anonymous_recovery(client, client_id, username):
    # Cognito documents alternating simulated delivery and InvalidParameter
    # responses for anonymous recovery, even with existence prevention enabled.
    # Never accept UserNotFound, throttling, credentials or an actual reset.
    try:
        result = client.forgot_password(ClientId=client_id, Username=username)
    except ClientError as error:
        assert error.response["Error"]["Code"] == "InvalidParameterException", "Recovery disclosed an account or failed unexpectedly"
        print("PASS: anonymous ForgotPassword returned the documented InvalidParameterException response")
    else:
        assert set(result) <= {"CodeDeliveryDetails", "ResponseMetadata"} and result.get("CodeDeliveryDetails")
        print("PASS: anonymous ForgotPassword returned simulated delivery metadata without authentication data")
    rejected(client.confirm_forgot_password, {"CodeMismatchException", "ExpiredCodeException"},
             ClientId=client_id, Username=username, ConfirmationCode="000000", Password="Qf9!" + secrets.token_urlsafe(28))


def load(v, receipt):
    live_state(v)
    assert set(receipt) == {"run_id", "code"} and receipt["run_id"] == v["recovery_run"], "Receipt belongs to another run"
    assert isinstance(receipt["code"], str) and re.fullmatch(r"[0-9]{6}", receipt["code"]), "Invalid receipt format"
    response = ssm().get_parameters(Names=PARAMETERS, WithDecryption=True)
    found = {p["Name"]: p for p in response["Parameters"]}
    assert set(found) == set(PARAMETERS) and all(p["Type"] == "SecureString" for p in found.values()), "Incomplete encrypted fixture"
    fixture = json.loads(found[PARAMETERS[0]]["Value"])
    assert all(fixture[k] == v[k] for k in ("pool", "client", "fixture_client", "deadline", "recovery_run")), "Fixture binding mismatch"
    return fixture, found[PARAMETERS[1]]["Value"]


def start():
    v = control.values()
    live_state(v)
    empty()
    email = control.rehearsal_email()
    control.prepare()
    bundle = json.loads((control.Path(os.environ["RUNNER_TEMP"]) / "cognito-browser-bundle.json").read_text())
    client = boto3.client("cognito-idp", region_name="ca-central-1")
    user = bundle["users"]["mapped"]
    # Seed an already-verified account for recovery. Real signup/email proof is
    # a separate email-start/verify-stop test; no recovery code is intercepted.
    client.admin_update_user_attributes(UserPoolId=v["pool"], Username=user["subject"],
        UserAttributes=[{"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"}])
    print("PASS: disposable verified-email recovery fixture configured")
    fixture = {**v, **{k: user[k] for k in ("password", "totp", "subject", "enrolled_at")}, "email": email}
    save(fixture, user["fixture_refresh"])
    print("PASS: temporary recovery fixture encrypted in Standard SecureStrings")
    for name in ("qf-browser-unknown@example.invalid", bundle["users"]["unverified"]["email"]):
        anonymous_recovery(client, v["client"], name)
    print("PASS: unknown and unverified accounts cannot reset with an invalid code; existence prevention remains enabled")
    result = client.forgot_password(ClientId=v["client"], Username=email)
    assert result["CodeDeliveryDetails"]["DeliveryMedium"] == "EMAIL" and "AuthenticationResult" not in result
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as out:
        out.write(f"Recovery run {v['recovery_run']} awaits the real inbox code until {v['deadline']} UTC.\n\n")
        out.write('Set the temporary encrypted Actions secret COGNITO_RECOVERY_RECEIPT to JSON with run_id (a string) and code from the newest recovery email. Never use workflow inputs, chat, logs or artifacts for the code. Run recovery-finish-stop immediately, then delete the receipt secret. Run stop if the handoff cannot finish.\n')
    print("PASS: public ForgotPassword requested one real email; delivery and reset are not yet claimed")


def login_challenge(client, fixture, password):
    result = client.admin_initiate_auth(UserPoolId=fixture["pool"], ClientId=fixture["fixture_client"],
        AuthFlow="ADMIN_USER_PASSWORD_AUTH", AuthParameters={"USERNAME": fixture["subject"], "PASSWORD": password})
    assert result.get("ChallengeName") == "SOFTWARE_TOKEN_MFA" and "AuthenticationResult" not in result, "Password bypassed MFA"
    return result


def refresh_session(client, fixture, refresh):
    return client.initiate_auth(ClientId=fixture["fixture_client"], AuthFlow="REFRESH_TOKEN_AUTH",
                               AuthParameters={"REFRESH_TOKEN": refresh})["AuthenticationResult"]["AccessToken"]


def verify(client, fixture, refresh, code):
    # Establish an unexpired working session immediately before reset. Merely
    # observing the original five-minute token expire would be a false pass.
    access = refresh_session(client, fixture, refresh)
    before = client.get_user(AccessToken=access)
    assert next(a["Value"] for a in before["UserAttributes"] if a["Name"] == "sub") == fixture["subject"]
    login_challenge(client, fixture, fixture["password"])
    args = {"ClientId": fixture["client"], "Username": fixture["email"]}
    password = "Qf9!" + secrets.token_urlsafe(32)
    wrong = str((int(code) + 1) % 1000000).zfill(6)
    rejected(client.confirm_forgot_password, {"CodeMismatchException"}, **args, ConfirmationCode=wrong, Password=password)
    rejected(client.confirm_forgot_password, {"InvalidPasswordException"}, **args, ConfirmationCode=code, Password="weak")
    print("PASS: wrong recovery code and weak replacement password rejected")
    reset_at = time.monotonic()
    result = client.confirm_forgot_password(**args, ConfirmationCode=code, Password=password)
    assert not set(result) - {"ResponseMetadata"}, "Reset unexpectedly returned authentication data"
    print("PASS: real inbox code completed public ConfirmForgotPassword without issuing tokens")
    rejected(client.admin_initiate_auth, {"NotAuthorizedException"}, UserPoolId=fixture["pool"], ClientId=fixture["fixture_client"],
             AuthFlow="ADMIN_USER_PASSWORD_AUTH", AuthParameters={"USERNAME": fixture["subject"], "PASSWORD": fixture["password"]})
    print("PASS: old password rejected after reset")
    rejected(client.get_user, {"NotAuthorizedException"}, AccessToken=access)
    print("PASS: freshly validated pre-reset access token rejected")
    rejected(client.initiate_auth, {"NotAuthorizedException"}, ClientId=fixture["fixture_client"], AuthFlow="REFRESH_TOKEN_AUTH",
             AuthParameters={"REFRESH_TOKEN": refresh})
    assert time.monotonic() - reset_at < 120, "Session check could be hidden by expiry"
    print("PASS: pre-reset refresh token rejected before ordinary access-token expiry")
    rejected(client.confirm_forgot_password, {"ExpiredCodeException", "CodeMismatchException", "NotAuthorizedException"},
             **args, ConfirmationCode=code, Password="Qf9!" + secrets.token_urlsafe(32))
    challenge = login_challenge(client, fixture, password)
    response_args = {"UserPoolId": fixture["pool"], "ClientId": fixture["fixture_client"], "ChallengeName": "SOFTWARE_TOKEN_MFA",
                     "Session": challenge["Session"]}
    username = challenge.get("ChallengeParameters", {}).get("USERNAME", fixture["subject"])
    now = time.time()
    adjacent = {control.totp(fixture["totp"], now + offset) for offset in (-60, -30, 0, 30, 60)}
    bad_totp = next(str(i).zfill(6) for i in range(6) if str(i).zfill(6) not in adjacent)
    rejected(client.admin_respond_to_auth_challenge, {"CodeMismatchException"}, **response_args,
             ChallengeResponses={"USERNAME": username, "SOFTWARE_TOKEN_MFA_CODE": bad_totp})
    # Fresh challenge and fresh time window: do not reuse enrollment's TOTP.
    challenge = login_challenge(client, fixture, password)
    now = time.time()
    if int(now // 30) <= fixture["enrolled_at"] // 30 or now % 30 > 24:
        time.sleep(31 - now % 30)
    result = client.admin_respond_to_auth_challenge(**{**response_args, "Session": challenge["Session"]},
        ChallengeResponses={"USERNAME": username, "SOFTWARE_TOKEN_MFA_CODE": control.totp(fixture["totp"], time.time())})
    after = client.get_user(AccessToken=result["AuthenticationResult"]["AccessToken"])
    attrs = {a["Name"]: a["Value"] for a in after["UserAttributes"]}
    assert attrs["sub"] == fixture["subject"] and attrs["email"] == fixture["email"] and attrs["email_verified"] == "true"
    assert after["PreferredMfaSetting"] == "SOFTWARE_TOKEN_MFA" and after["UserMFASettingList"] == ["SOFTWARE_TOKEN_MFA"]
    print("PASS: reset code cannot be reused; new password still requires the existing TOTP; wrong TOTP rejected; identity and verified email preserved")


def finish():
    v = control.values()
    fixture, refresh = load(v, json.loads(os.environ["COGNITO_RECOVERY_RECEIPT"]))
    assert fixture["email"] == control.rehearsal_email(), "Recovery inbox changed during the run"
    client = boto3.client("cognito-idp", region_name="ca-central-1")
    control.configuration(client, v)
    verify(client, fixture, refresh, json.loads(os.environ["COGNITO_RECOVERY_RECEIPT"])["code"])
