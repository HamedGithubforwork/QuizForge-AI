"""Fail-closed session revocation after production Cognito password recovery."""
import boto3
from botocore.config import Config


def handler(event, context):
    trigger = event.get("triggerSource", "")
    if trigger == "PostConfirmation_ConfirmSignUp":
        return event
    if trigger != "PostConfirmation_ConfirmForgotPassword":
        raise ValueError("Unsupported identity trigger")

    # Invocation is restricted to this pool/account, and the role can revoke
    # tokens only in this pool. Never accept a target from clientMetadata.
    pool = event["userPoolId"]
    username = event["userName"]
    if (
        event.get("region") != "ca-central-1"
        or not pool.startswith("ca-central-1_")
        or not username
    ):
        raise ValueError("Invalid recovery trigger")

    try:
        boto3.client(
            "cognito-idp",
            region_name="ca-central-1",
            config=Config(
                connect_timeout=1,
                read_timeout=1,
                retries={"total_max_attempts": 2},
            ),
        ).admin_user_global_sign_out(
            UserPoolId=pool,
            Username=username,
        )
    except Exception:
        # Cognito must not return successful recovery if revocation failed.
        # Suppress provider details and the event to keep inboxes/tokens private.
        raise RuntimeError("Recovery session revocation failed") from None

    return event
