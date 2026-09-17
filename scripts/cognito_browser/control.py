"""Trusted main-branch controller. Never prints credentials, tokens or inboxes."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import traceback
from uuid import UUID
import zipfile

import boto3
from botocore.exceptions import ClientError
import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/rds_rehearsal"))
from cognito_profile import totp
from probe import fixtures, fingerprint, insert

NAME = "quizforge-cognito-browser-rehearsal"
TF = ROOT / "infra/aws/cognito-browser-rehearsal"


def values():
    result = subprocess.run(["terraform", "-chdir=" + str(TF), "output", "-json"], check=True, capture_output=True, text=True)
    return json.loads(result.stdout).get("rehearsal", {}).get("value")


def package():
    with zipfile.ZipFile(TF / "pre_signup.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(Path(__file__).with_name("pre_signup.py"), "pre_signup.py")


def configure():
    email = os.getenv("QUIZFORGE_CANARY_EMAIL", "").strip().lower()
    email_mode = os.environ["OPERATION"] == "email-start"
    if email_mode and (not email or "@" not in email or any(c in email for c in "\r\n")):
        raise RuntimeError("A dedicated canary inbox must be configured before email-start")
    digest = hashlib.sha256(email.encode()).hexdigest() if email_mode else ""
    deadline = (datetime.now(timezone.utc) + timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(os.environ["GITHUB_ENV"], "a") as out:
        out.write(f"TF_VAR_email_sha256={digest}\nTF_VAR_deadline={deadline}\n")
    if values():
        raise RuntimeError("An earlier rehearsal still exists. Run stop before starting another.")
    print("PASS: isolated state is empty; maximum manual email lease is 30 minutes")


def configuration(client, v):
    pool = client.describe_user_pool(UserPoolId=v["pool"])["UserPool"]
    assert pool["Name"] == NAME and pool["UserPoolTier"] == "LITE" and pool["MfaConfiguration"] == "ON"
    assert pool["AutoVerifiedAttributes"] == ["email"] and pool["UsernameAttributes"] == ["email"]
    assert not pool["AdminCreateUserConfig"]["AllowAdminCreateUserOnly"]
    assert pool["EmailConfiguration"]["EmailSendingAccount"] == "COGNITO_DEFAULT"
    assert not pool.get("SmsConfiguration") and pool.get("UserPoolAddOns", {}).get("AdvancedSecurityMode", "OFF") == "OFF"
    assert set(pool["LambdaConfig"]) == {"PreSignUp"}
    policy = pool["Policies"]["PasswordPolicy"]
    assert policy["MinimumLength"] >= 14 and all(policy[k] for k in ("RequireLowercase","RequireUppercase","RequireNumbers","RequireSymbols"))
    app = client.describe_user_pool_client(UserPoolId=v["pool"], ClientId=v["client"])["UserPoolClient"]
    assert not app.get("ClientSecret") and app["AllowedOAuthFlows"] == ["code"]
    assert app["CallbackURLs"] == ["http://localhost:4174/auth/callback"] and app["LogoutURLs"] == ["http://localhost:4174/"]
    assert app["EnableTokenRevocation"] and app["ExplicitAuthFlows"] == ["ALLOW_REFRESH_TOKEN_AUTH"]
    assert app["AccessTokenValidity"] == 5 and app["TokenValidityUnits"]["AccessToken"] == "minutes"
    print("PASS: live Cognito configuration requires PKCE-compatible code flow, email verification, strong passwords and TOTP")


def private_file(name, content):
    path = Path(os.environ["RUNNER_TEMP"]) / name
    with open(path, "w", opener=lambda p, flags: os.open(p, flags, 0o600)) as handle:
        handle.write(content)
    return path


def prepare():
    v = values()
    client = boto3.client("cognito-idp", region_name="ca-central-1")
    configuration(client, v)
    users = {}
    for name in ("mapped", "unmapped", "unverified"):
        email = f"qf-browser-{name}@example.invalid"
        password = "Qf9!" + secrets.token_urlsafe(28)
        client.admin_create_user(UserPoolId=v["pool"], Username=email, MessageAction="SUPPRESS", UserAttributes=[
            {"Name":"email", "Value":email}, {"Name":"email_verified", "Value":"false" if name == "unverified" else "true"}])
        client.admin_set_user_password(UserPoolId=v["pool"], Username=email, Password=password, Permanent=True)
        login = client.admin_initiate_auth(UserPoolId=v["pool"], ClientId=v["fixture_client"], AuthFlow="ADMIN_USER_PASSWORD_AUTH",
                                          AuthParameters={"USERNAME":email,"PASSWORD":password})
        assert login["ChallengeName"] == "MFA_SETUP" and "AuthenticationResult" not in login
        challenge_username = login.get("ChallengeParameters", {}).get("USERNAME", email)
        association = client.associate_software_token(Session=login["Session"])
        secret = association["SecretCode"]
        verified = client.verify_software_token(Session=association["Session"], UserCode=totp(secret,time.time()))
        assert verified["Status"] == "SUCCESS"
        result = client.admin_respond_to_auth_challenge(UserPoolId=v["pool"], ClientId=v["fixture_client"], ChallengeName="MFA_SETUP",
            Session=verified["Session"], ChallengeResponses={"USERNAME":challenge_username})["AuthenticationResult"]
        user = client.get_user(AccessToken=result["AccessToken"])
        subject = str(UUID(next(a["Value"] for a in user["UserAttributes"] if a["Name"] == "sub")))
        client.admin_set_user_mfa_preference(UserPoolId=v["pool"], Username=email,
            SoftwareTokenMfaSettings={"Enabled":True,"PreferredMfa":True})
        users[name] = {"email":email,"password":password,"totp":secret,"subject":subject,
                       "fixture_access":result["AccessToken"],"enrolled_at":int(time.time())}
    # Public signup is denied before delivery in automated mode, including for
    # synthetic names that are only permitted through IAM AdminCreateUser.
    try:
        client.sign_up(ClientId=v["client"], Username="blocked@example.invalid", Password="Qf9!"+secrets.token_urlsafe(28),
                       UserAttributes=[{"Name":"email","Value":"blocked@example.invalid"}])
    except ClientError as error:
        assert error.response["Error"]["Code"] == "UserLambdaValidationException"
    else: raise AssertionError("Unapproved public signup was accepted")
    private_file("cognito-browser-bundle.json", json.dumps({**v,"users":users}))
    print("PASS: three synthetic TOTP accounts prepared; public signup guard rejects unapproved inboxes; no email delivery claimed")


def database(verify=False):
    assert os.environ["PGHOST"] == "127.0.0.1" and os.environ["PGDATABASE"] == "quizforge_rehearsal"
    bundle = json.loads((Path(os.environ["RUNNER_TEMP"])/"cognito-browser-bundle.json").read_text())
    with psycopg.connect(sslmode="verify-full", autocommit=True, row_factory=dict_row) as owner:
        if verify:
            rows = owner.execute("SELECT * FROM app.quiz_history").fetchall()
            assert fingerprint(rows) == fingerprint(fixtures())
            assert owner.execute("SELECT count(*) AS n FROM app.users").fetchone()["n"] == 4
            assert owner.execute("SELECT count(*) AS n FROM app.identity_challenges WHERE used_at IS NOT NULL").fetchone()["n"] == 1
            print("PASS: live browser enrollment consumed one confirmation; eight foreign-history fixtures are unchanged")
            return
        owner.execute((ROOT/"scripts/rds_rehearsal/schema.sql").read_text())
        owner.execute((ROOT/"scripts/rds_rehearsal/identity_schema.sql").read_text())
        issuer = "https://cognito-idp.ca-central-1.amazonaws.com/"+bundle["pool"]
        for number in (1,2,3):
            user = UUID(int=number)
            subject = bundle["users"]["mapped"]["subject"] if number == 3 else str(user)
            owner.execute("INSERT INTO app.users VALUES (%s)",(user,))
            owner.execute("INSERT INTO app.user_identities VALUES (%s,%s,%s)",(issuer,subject,user))
        for row in fixtures(): insert(owner,row)
        for role, prefix in (("quizforge_app","HISTORY_DB"),("quizforge_identity","IDENTITY_DB")):
            password = secrets.token_urlsafe(32)
            with psycopg.ClientCursor(owner) as cursor:
                from psycopg import sql
                cursor.execute(sql.SQL("ALTER ROLE {} PASSWORD %s").format(sql.Identifier(role)), (password,))
            env = {"AUTH_PROVIDER":"cognito","COGNITO_USER_POOL_ID":bundle["pool"],"COGNITO_CLIENT_ID":bundle["client"],
                prefix+"_HOST":"postgres",prefix+"_NAME":"quizforge_rehearsal",prefix+"_USER":role,prefix+"_PASSWORD":password,
                prefix+"_SSLROOTCERT":"/run/test-ca.pem","AWS_EC2_METADATA_DISABLED":"true"}
            if role == "quizforge_app": env.update(HISTORY_BACKEND="postgres",REDIS_URL="redis://redis:6379/0",ALLOWED_ORIGINS="http://localhost:4174")
            else: env.update(IDENTITY_STAGING_ENABLED="true",IDENTITY_ALLOWED_ORIGIN="http://localhost:4174")
            private_file(role+".env", "".join(f"{k}={v}\n" for k,v in env.items()))
    print("PASS: runner-only TLS PostgreSQL seeded with separate history/enrollment credentials")


def email_start():
    v = values()
    client = boto3.client("cognito-idp", region_name="ca-central-1")
    configuration(client, v)
    email = os.environ["QUIZFORGE_CANARY_EMAIL"].strip().lower()
    # An unrelated random password is never persisted, displayed or reused.
    # This account exists only to prove real signup and inbox confirmation.
    result = client.sign_up(ClientId=v["client"], Username=email, Password="Qf9!"+secrets.token_urlsafe(32),
                            UserAttributes=[{"Name":"email","Value":email}])
    assert not result["UserConfirmed"]
    assert result["CodeDeliveryDetails"]["DeliveryMedium"] == "EMAIL"
    user = client.admin_get_user(UserPoolId=v["pool"], Username=email)
    attrs = {a["Name"]:a["Value"] for a in user["UserAttributes"]}
    assert user["UserStatus"] == "UNCONFIRMED" and attrs.get("email_verified", "false") == "false"
    with open(os.environ["GITHUB_STEP_SUMMARY"],"a") as out:
        out.write(f"Email verification window ends at {v['deadline']} (UTC).\n\n")
        out.write("Cognito accepted signup and requested email delivery to the configured dedicated canary inbox. Open the verification link in the email titled 'Verify your temporary QuizForge AWS test account'. Do not paste the link or codes into chat or workflow inputs. Run email-verify-stop after confirmation; stop also works without a completed test.\n")
    print("PASS: real signup accepted, email delivery requested, account remains unconfirmed; inbox delivery and confirmation are not yet claimed")


def verify_email():
    v = values()
    client = boto3.client("cognito-idp", region_name="ca-central-1")
    user = client.admin_get_user(UserPoolId=v["pool"], Username=os.environ["QUIZFORGE_CANARY_EMAIL"].strip().lower())
    attrs = {a["Name"]:a["Value"] for a in user["UserAttributes"]}
    assert user["UserStatus"] == "CONFIRMED" and attrs.get("email_verified") == "true"
    assert attrs["email"].lower() == os.environ["QUIZFORGE_CANARY_EMAIL"].strip().lower()
    assert not attrs["email"].endswith("@example.invalid")
    print("PASS: dedicated-inbox signup reached CONFIRMED with email_verified=true; real email confirmation completed")


def cleanup_due():
    v = values()
    due = not v or datetime.now(timezone.utc) >= datetime.fromisoformat(v["deadline"].replace("Z","+00:00"))
    if os.environ.get("GITHUB_EVENT_NAME") != "schedule": due = True
    with open(os.environ["GITHUB_OUTPUT"],"a") as out: out.write("due="+str(due).lower()+"\n")


def absent():
    client = boto3.client("cognito-idp", region_name="ca-central-1")
    for page in client.get_paginator("list_user_pools").paginate(MaxResults=60):
        assert all(pool["Name"] != NAME for pool in page["UserPools"])
    account = boto3.client("sts").get_caller_identity()["Account"]
    assert not client.describe_user_pool_domain(Domain="quizforge-browser-"+account).get("DomainDescription",{}).get("UserPoolId")
    for service, operation, args, missing in (
        ("lambda","get_function",{"FunctionName":NAME},"ResourceNotFoundException"),
        ("iam","get_role",{"RoleName":NAME},"NoSuchEntity")):
        try: getattr(boto3.client(service,region_name="ca-central-1"),operation)(**args)
        except ClientError as error: assert error.response["Error"]["Code"] == missing
        else: raise AssertionError("Temporary identity infrastructure remains")
    groups = boto3.client("logs",region_name="ca-central-1").describe_log_groups(logGroupNamePrefix="/aws/lambda/"+NAME)["logGroups"]
    assert not any(g["logGroupName"] == "/aws/lambda/"+NAME for g in groups)
    assert values() is None
    print("PASS: Cognito pool/users/clients/domain, signup Lambda, IAM role and log group are absent; Terraform state has no rehearsal output")


if __name__ == "__main__":
    try:
        action = sys.argv[1]
        if action == "database-verify": database(True)
        else: {"package":package,"configure":configure,"prepare":prepare,"database":database,"email-start":email_start,
               "verify-email":verify_email,"cleanup-due":cleanup_due,"absent":absent}[action]()
    except Exception as error:
        line = traceback.extract_tb(error.__traceback__)[-1].lineno
        print(f"ERROR: Cognito browser rehearsal failed ({type(error).__name__}, phase {sys.argv[1]}, line {line})")
        sys.exit(1)
