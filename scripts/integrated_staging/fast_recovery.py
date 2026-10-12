"""One-time reviewed in-place staging recovery Lambda installation.

No new staging server or Cognito pool. Reject all Terraform drift, replacements,
unexpected resource creations, and live identity or application changes.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import sys

import control
import fast_auth
import fast_frontend
import fast_password
import fast_parity
from guards import NAME
from package_recovery import DEST, package

POOL = "aws_cognito_user_pool.browser"
NEW = frozenset({
    "aws_cloudwatch_log_group.recovery",
    "aws_iam_role.recovery",
    "aws_lambda_function.recovery",
    "aws_iam_role_policy.recovery",
    "aws_lambda_permission.recovery",
})


def verify_plan(plan, pool_id):
    if (not isinstance(plan, dict) or plan.get("errored")
            or not plan.get("format_version") or plan.get("resource_drift")):
        raise ValueError("Unexpected Terraform plan or resource drift")
    changes = {}
    for entry in plan.get("resource_changes", []):
        if entry.get("mode", "managed") != "managed":
            continue
        action = entry.get("change", {}).get("actions")
        if action == ["no-op"]:
            continue
        name = entry.get("address")
        if name in changes or name not in NEW | {POOL}:
            raise ValueError("Recovery migration contains unrelated resource changes")
        if action != (["update"] if name == POOL else ["create"]):
            raise ValueError("Unexpected replacement, destroy or mutation")
        changes[name] = entry.get("change", {})
    if set(changes) != NEW | {POOL}:
        raise ValueError("Exactly five new hook resources and one pool update required")
    before, after = changes[POOL].get("before"), changes[POOL].get("after")
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise ValueError("No old or new Cognito pool configuration")
    fast_parity._pool(before, pool_id, signup=(
        not before["admin_create_user_config"][0]["allow_admin_create_user_only"]
    ), updated=True)
    fast_parity._pool(after, pool_id, signup=(
        not before["admin_create_user_config"][0]["allow_admin_create_user_only"]
    ), updated=True)
    existing = before.get("lambda_config") or []
    attached = after.get("lambda_config") or []
    if existing or not isinstance(attached, list) or len(attached) != 1:
        raise ValueError("Recovery hook must be newly attached")
    if set(attached[0]) - {"post_confirmation", "custom_message", "define_auth_challenge",
                          "create_auth_challenge", "verify_auth_challenge_response",
                          "pre_sign_up", "pre_authentication", "post_authentication",
                          "pre_token_generation", "user_migration", "custom_email_sender",
                          "custom_sms_sender", "kms_key_id", "pre_token_generation_config"}:
        raise ValueError("Unexpected Lambda triggers")
    if any(value for key, value in attached[0].items() if key != "post_confirmation"):
        raise ValueError("Only post-confirmation recovery trigger is authorized")
    diff = {k for k in before.keys() | after.keys() if before.get(k) != after.get(k)}
    if diff != {"lambda_config"}:
        raise ValueError("Recovery migration may only attach one Cognito trigger")
    resource = changes["aws_lambda_function.recovery"].get("after") or {}
    if (resource.get("function_name") != NAME + "-recovery"
            or resource.get("runtime") != "python3.13"
            or resource.get("handler") != "identity_triggers.handler"
            or resource.get("timeout") != 5
            or resource.get("memory_size") != 128):
        raise ValueError("Unexpected staging recovery Lambda configuration")
    for name in NEW:
        item = changes[name]
        if item.get("before") is not None:
            raise ValueError("Recovery migration cannot adopt or replace resources")
    if any(c.get("change", {}).get("actions") != ["no-op"]
           for c in plan.get("output_changes", {}).values()):
        raise ValueError("Recovery cannot change staging outputs")
    return True


def expected_arn():
    account = control.client("sts").get_caller_identity()["Account"]
    if not isinstance(account, str) or len(account) != 12 or not account.isdecimal():
        raise ValueError("Unexpected AWS staging account")
    return f"arn:aws:lambda:ca-central-1:{account}:function:{NAME}-recovery"


def live_attached(pool_id):
    return (control.client("cognito-idp").describe_user_pool(
        UserPoolId=pool_id)["UserPool"].get("LambdaConfig") or {}).get("PostConfirmation")


def verify_live(pool_id):
    target = expected_arn()
    if live_attached(pool_id) != target:
        raise ValueError("Cognito recovery session revocation trigger not attached")
    conf = control.client("lambda").get_function(FunctionName=NAME + "-recovery")["Configuration"]
    expected_digest = base64.b64encode(hashlib.sha256(DEST.read_bytes()).digest()).decode()
    if (conf.get("FunctionArn") != target or conf.get("Runtime") != "python3.13"
            or conf.get("Handler") != "identity_triggers.handler"
            or conf.get("CodeSha256") != expected_digest):
        raise ValueError("Effective recovery hook differs from reviewed production handler")
    return True


def update():
    if os.environ.get("STAGING_AUTH_UPDATE") != "align_recovery_hook":
        raise ValueError("Explicit one-time staging recovery authorization is required")
    package()
    values, config = fast_frontend.live()
    pool_id = values["pool"]
    if fast_password.live_minimum(pool_id) != 8:
        raise ValueError("Existing Cognito password policy is not production-parity")
    fast_parity.live_email_controls(pool_id)
    hook = live_attached(pool_id)
    if hook:
        verify_live(pool_id)
        print("PASS: existing staging recovery hook already matches production source")
        return
    plan_path = Path(os.environ["RUNNER_TEMP"]) / "staging-recovery.tfplan"
    if plan_path.exists():
        raise ValueError("A previously saved plan already exists")
    try:
        fast_auth._terraform(
            "plan", "-input=false", "-no-color", "-lock-timeout=60s",
            "-target=" + POOL,
            "-target=aws_lambda_permission.recovery",
            "-target=aws_iam_role_policy.recovery",
            "-var=enable_test_signup=" + str(control.signup_policy(values)).lower(),
            "-out=" + str(plan_path),
        )
        plan = json.loads(fast_auth._terraform("show", "-json", str(plan_path)))
        verify_plan(plan, pool_id)
        current, current_config = fast_frontend.live()
        if current != values or current_config != config or live_attached(pool_id):
            raise ValueError("Staging changed after recovery plan audit")
        fast_auth._terraform("apply", "-input=false", "-no-color", str(plan_path))
        actual, actual_config = fast_frontend.live()
        if actual != values or actual_config != config:
            raise ValueError("Staging resources changed during recovery attachment")
        verify_live(pool_id)
        print("PASS: production-identical recovery Lambda attached only to existing staging pool")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as out:
                out.write("## Staging recovery parity verified\n\n")
                out.write("Only the isolated staging recovery Lambda, narrow role/log/invocation permission and Cognito post-confirmation hook were added. Production and staging servers were unchanged; manual Stop remains.\n")
    finally:
        plan_path.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        if sys.argv[1:] != ["update"]:
            raise ValueError("Unsupported staging recovery operation")
        update()
    except Exception as error:
        print("Staging recovery parity refused: " + type(error).__name__)
        raise SystemExit(1)
