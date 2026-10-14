"""Read-only, fixed-field evidence for a production Google OAuth rejection.

Never print raw AWS objects, logs, user attributes or OAuth credentials.
"""
import hmac
import json
import os
import time

from scripts.production.lightsail.google_provider_readiness import (
    ACCOUNT_ID, CLIENT_NAME, POOL_NAME, REGION, exact_one, validate_google_credentials,
)

FUNCTION = "quizforge-production-lightsail-recovery"
FUNCTION_ARN = "arn:aws:lambda:ca-central-1:399311815467:function:" + FUNCTION
LOG_GROUP = "/aws/lambda/" + FUNCTION


def evidence(*, sts, cognito, functions, logs, client_id, secret, now=None):
    if not validate_google_credentials(client_id, secret):
        raise ValueError("Protected credentials unavailable")
    if sts.get_caller_identity().get("Account") != ACCOUNT_ID:
        raise ValueError("Unexpected account")
    pool_id = exact_one(cognito, "list_user_pools", "UserPools", POOL_NAME, MaxResults=60)["Id"]
    if not pool_id.startswith(REGION + "_"):
        raise ValueError("Unexpected region")
    app_id = exact_one(cognito, "list_user_pool_clients", "UserPoolClients", CLIENT_NAME,
                       UserPoolId=pool_id, MaxResults=60)["ClientId"]
    pool = cognito.describe_user_pool(UserPoolId=pool_id)["UserPool"]
    app = cognito.describe_user_pool_client(UserPoolId=pool_id, ClientId=app_id)["UserPoolClient"]
    provider = cognito.describe_identity_provider(UserPoolId=pool_id, ProviderName="Google")["IdentityProvider"]
    function = functions.get_function_configuration(FunctionName=FUNCTION)
    if function.get("FunctionArn") != FUNCTION_ARN:
        raise ValueError("Unexpected recovery function")
    triggers = pool.get("LambdaConfig", {})
    details = provider.get("ProviderDetails", {})
    stored_secret = details.get("client_secret")
    mapping = provider.get("AttributeMapping", {})
    schema = {item.get("Name"): item for item in pool.get("SchemaAttributes", [])}
    report = {
        "google_client_id_matches": details.get("client_id") == client_id,
        "google_client_secret_matches": isinstance(stored_secret, str) and
            hmac.compare_digest(stored_secret.encode(), secret.encode()),
        "google_mapping_matches": provider.get("AttributeMapping") ==
            {"email": "email", "email_verified": "email_verified", "username": "sub"},
        "google_email_mapping_matches": mapping.get("email") == "email",
        "google_verified_email_mapping_matches": mapping.get("email_verified") == "email_verified",
        "google_default_username_mapping": mapping.get("username") == "sub",
        "google_unexpected_mapping_present": bool(set(mapping) - {"email", "email_verified", "username"}),
        "email_schema_mutable": schema.get("email", {}).get("Mutable") is True,
        "unmapped_required_schema_attribute": any(
            item.get("Required") is True and name not in mapping and name != "sub"
            for name, item in schema.items()),
        "google_client_authorized": "Google" in app.get("SupportedIdentityProviders", []),
        "email_write_permission": "email" in app.get("WriteAttributes", []),
        "public_signup_enabled": not pool.get("AdminCreateUserConfig", {}).get("AllowAdminCreateUserOnly", True),
        "pre_signup_trigger_absent_as_expected": not bool(triggers.get("PreSignUp")),
        "post_confirmation_is_recovery_function": triggers.get("PostConfirmation") == FUNCTION_ARN,
        "recent_rehearsal_signup_rejection": False,
        "recent_unsupported_trigger_rejection": False,
        "log_scan_complete": False,
    }
    # Bounded scan of only this function's recent errors. Provider contents stay
    # in memory; emit only exact known signatures, never surrounding log text.
    start = int(((time.time() if now is None else now) - 4 * 3600) * 1000)
    token = None
    for _ in range(10):
        args = {"logGroupName": LOG_GROUP, "startTime": start, "limit": 1000,
                "filterPattern": '?"Signup is not allowed for this rehearsal" ?"Unsupported identity trigger"'}
        if token:
            args["nextToken"] = token
        page = logs.filter_log_events(**args)
        for event in page.get("events", []):
            message = event.get("message", "")
            if not isinstance(message, str):
                continue
            if "ValueError: Signup is not allowed for this rehearsal" in message:
                report["recent_rehearsal_signup_rejection"] = True
            if "ValueError: Unsupported identity trigger" in message:
                report["recent_unsupported_trigger_rejection"] = True
        new_token = page.get("nextToken")
        if not new_token or new_token == token:
            report["log_scan_complete"] = True
            break
        token = new_token
    return report


def main():
    import boto3
    try:
        result = evidence(sts=boto3.client("sts", region_name=REGION),
                          cognito=boto3.client("cognito-idp", region_name=REGION),
                          functions=boto3.client("lambda", region_name=REGION),
                          logs=boto3.client("logs", region_name=REGION),
                          client_id=os.getenv("PROD_GOOGLE_OAUTH_CLIENT_ID"),
                          secret=os.getenv("PROD_GOOGLE_OAUTH_CLIENT_SECRET"))
    except Exception:
        raise SystemExit("FAIL: read-only Google incident evidence unavailable; no changes made") from None
    print("Google incident fixed-field evidence: " + json.dumps(result, sort_keys=True))
    print("No production settings, credentials, users or release changed.")


if __name__ == "__main__":
    main()
