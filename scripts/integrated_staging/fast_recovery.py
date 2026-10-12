"""One-time reviewed in-place staging recovery Lambda installation.

No new staging server or Cognito pool. Reject all Terraform drift, replacements,
unexpected resource creations, and live identity or application changes.
"""
import base64
import hashlib
import json
import os
import re
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

# All printed labels are literals. Never display Terraform plans, provider
# exceptions, account IDs, token-bearing state or AWS response bodies.
SAFE_REJECTION_REASONS = frozenset({
    "Unexpected Terraform plan or resource drift",
    "Recovery migration contains unrelated resource changes",
    "Unexpected replacement, destroy or mutation",
    "Exactly five new hook resources and one pool update required",
    "No old or new Cognito pool configuration",
    "Recovery hook must be newly attached",
    "Existing staging plan contains an active Lambda trigger",
    "Unexpected planned Cognito Lambda block shape",
    "Unapproved additional Lambda trigger",
    "Planned post-confirmation trigger is not proven",
    "Unexpected staging recovery Lambda ARN",
    "Staging source defines unreviewed Cognito Lambda triggers",
    "Unexpected active Lambda trigger after recovery update",
    "Unexpected Lambda triggers",
    "Only post-confirmation recovery trigger is authorized",
    "Recovery migration may only attach one Cognito trigger",
    "Unexpected staging recovery Lambda configuration",
    "Recovery migration cannot adopt or replace resources",
    "Recovery cannot change staging outputs",
    "Unexpected Cognito pool identity",
    "Unexpected Cognito MFA mode",
    "Parity change must preserve disposable pool boundary",
    "Cognito username mode changed",
    "Existing staging signup mode changed",
    "Authenticator support changed",
    "Unexpected email auto-verification policy",
    "Unexpected Cognito recovery block",
    "Unexpected Cognito recovery methods",
    "Unexpected Cognito account recovery mechanism",
    "Email attribute changes must require verification",
    "Cognito email confirmation must use codes",
})


def checkpoint(label):
    """Safe, deliberately limited deployment progress diagnostics."""
    print("STAGING_RECOVERY_PHASE=" + label, flush=True)

NEW = frozenset({
    "aws_cloudwatch_log_group.recovery",
    "aws_iam_role.recovery",
    "aws_lambda_function.recovery",
    "aws_iam_role_policy.recovery",
    "aws_lambda_permission.recovery",
})


def _blank(value):
    """Empty defaults are not an attached Cognito Lambda trigger."""
    if value is None or value == "" or value is False:
        return True
    if isinstance(value, (list, dict)):
        values = value.values() if isinstance(value, dict) else value
        return all(_blank(item) for item in values)
    return False


def _review_lambda_change(change, *, expected_hook_arn=None):
    before, after = change["before"], change["after"]
    previous = before.get("lambda_config") or []
    if not isinstance(previous, list) or len(previous) > 1 or not _blank(previous):
        raise ValueError("Existing staging plan contains an active Lambda trigger")

    proposed = after.get("lambda_config") or []
    computed = (change.get("after_unknown") or {}).get("lambda_config") or []
    if not isinstance(computed, list) or len(computed) > 1 or (
        len(computed) == 1 and not isinstance(computed[0], dict)
    ):
        raise ValueError("Unexpected planned Cognito Lambda block shape")
    if not isinstance(proposed, list) or len(proposed) > 1 or (
        len(proposed) == 1 and not isinstance(proposed[0], dict)
    ) or (not proposed and len(computed) != 1):
        raise ValueError("Unexpected planned Cognito Lambda block shape")

    known = proposed[0] if proposed else {}
    unknown = computed[0] if computed else {}
    if any(not _blank(v) for k, v in known.items() if k != "post_confirmation"):
        raise ValueError("Unapproved additional Lambda trigger")
    # Real provider 6.64.0 plans pre_token_generation_config as a
    # *computed* default when adding post_confirmation. We verified this
    # attribute name via an approved read-only AWS plan (#49). It is NOT an
    # approved configured pre-token Lambda: after-known values must be blank,
    # the reviewed HCL declares only post_confirmation, and the live pool
    # must have no additional active trigger after apply.
    if any(not _blank(v) for k, v in unknown.items()
           if k not in {"post_confirmation", "pre_token_generation_config"}):
        raise ValueError("Unapproved additional Lambda trigger")

    arn = known.get("post_confirmation")
    if arn:
        if not isinstance(arn, str) or not re.fullmatch(
            r"arn:aws:lambda:ca-central-1:[0-9]{12}:function:quizforge-integrated-staging-recovery",
            arn,
        ) or (expected_hook_arn is not None and arn != expected_hook_arn):
            raise ValueError("Unexpected staging recovery Lambda ARN")
    elif unknown.get("post_confirmation") is not True:
        raise ValueError("Planned post-confirmation trigger is not proven")
    return True


def _plan_shape(value):
    """Expose only one of three fixed categories, never Terraform values."""
    if value is None or value == []:
        return "empty"
    if isinstance(value, list) and len(value) == 1 and isinstance(value[0], dict):
        return "blank-block" if _blank(value[0]) else "configured-block"
    return "other"


# Output only trusted Terraform *schema field names*, never plan field
# values, unrecognized dynamic keys, ARNs, tokens or AWS account identifiers.
KNOWN_LAMBDA_FIELDS = frozenset({
    "post_confirmation", "pre_sign_up", "pre_authentication",
    "post_authentication", "custom_message", "define_auth_challenge",
    "create_auth_challenge", "verify_auth_challenge_response",
    "user_migration", "pre_token_generation",
    "pre_token_generation_config", "custom_email_sender", "custom_sms_sender",
    "kms_key_id", "email_mfa_message", "email_mfa_subject",
})


def _safe_hook_shape(plan):
    for item in plan.get("resource_changes", []):
        if item.get("address") == POOL:
            change = item.get("change", {})
            old = change.get("before") or {}
            new = change.get("after") or {}
            unknown = change.get("after_unknown") or {}
            labels = (
                _plan_shape(old.get("lambda_config")),
                _plan_shape(new.get("lambda_config")),
                _plan_shape(unknown.get("lambda_config")),
            )
            print("STAGING_RECOVERY_PLAN_SHAPE=" + ",".join(labels), flush=True)
            computed = unknown.get("lambda_config") or []
            if isinstance(computed, list) and len(computed) == 1 and isinstance(computed[0], dict):
                known_keys = sorted(
                    key for key, val in computed[0].items()
                    if key in KNOWN_LAMBDA_FIELDS and not _blank(val)
                )
                other_count = sum(
                    1 for key, val in computed[0].items()
                    if key not in KNOWN_LAMBDA_FIELDS and not _blank(val)
                )
                print("STAGING_RECOVERY_COMPUTED_FIELDS=" + (
                    ",".join(known_keys) if known_keys else "none"
                ), flush=True)
                print("STAGING_RECOVERY_UNKNOWN_FIELD_COUNT=" + str(other_count), flush=True)
            return


def verify_plan(plan, pool_id, *, expected_hook_arn=None):
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
    # Terraform may represent absent Cognito LambdaConfig as one empty map,
    # and the new Lambda ARN as after_unknown until the function is created.
    _review_lambda_change(changes[POOL], expected_hook_arn=expected_hook_arn)
    diff = {k for k in before.keys() | after.keys() if before.get(k) != after.get(k)}
    # Computed nested attributes may be absent from planned `after` even
    # though after_unknown proves exactly one new post-confirmation binding.
    pending = (changes[POOL].get("after_unknown") or {}).get("lambda_config") or []
    if isinstance(pending, list) and len(pending) == 1 and (
        isinstance(pending[0], dict) and pending[0].get("post_confirmation") is True
    ):
        diff.add("lambda_config")
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


def reviewed_lambda_source(source):
    """Only one exact post-confirmation Terraform block is permissible."""
    matches = re.findall(r"(?m)^\\s*lambda_config\\s*\\{([^{}]*)\\}", source)
    if len(matches) != 1 or re.sub(r"\\s+", "", matches[0]) != (
        "post_confirmation=aws_lambda_function.recovery.arn"
    ):
        raise ValueError("Staging source defines unreviewed Cognito Lambda triggers")
    return True


def check_extra_live_hooks(config):
    """Cognito may report harmless pre-token version metadata, not an ARN."""
    if not isinstance(config, dict):
        raise ValueError("Unexpected active Lambda trigger after recovery update")
    for key, value in config.items():
        if key == "PostConfirmation":
            continue
        if key == "PreTokenGenerationConfig":
            if isinstance(value, dict) and set(value) <= {"LambdaArn", "LambdaVersion"} and (
                not value.get("LambdaArn")
            ):
                continue
        if not _blank(value):
            raise ValueError("Unexpected active Lambda trigger after recovery update")
    return True


def verify_live(pool_id):
    target = expected_arn()
    pool = control.client("cognito-idp").describe_user_pool(UserPoolId=pool_id)["UserPool"]
    live_config = pool.get("LambdaConfig") or {}
    if live_config.get("PostConfirmation") != target:
        raise ValueError("Cognito recovery session revocation trigger not attached")
    check_extra_live_hooks(live_config)
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
    # Refuse an added unreviewed HCL trigger even if its ARN is computed.
    reviewed_lambda_source(
        (Path(__file__).resolve().parents[2] / "infra/aws/integrated-staging/main.tf")
        .read_text(encoding="utf-8")
    )
    checkpoint("package")
    package()
    checkpoint("validate-existing-environment")
    values, config = fast_frontend.live()
    pool_id = values["pool"]
    checkpoint("validate-password-policy")
    if fast_password.live_minimum(pool_id) != 8:
        raise ValueError("Existing Cognito password policy is not production-parity")
    checkpoint("validate-email-controls")
    fast_parity.live_email_controls(pool_id)
    checkpoint("inspect-existing-hook")
    hook = live_attached(pool_id)
    if hook:
        verify_live(pool_id)
        print("PASS: existing staging recovery hook already matches production source")
        return
    plan_path = Path(os.environ["RUNNER_TEMP"]) / "staging-recovery.tfplan"
    if plan_path.exists():
        raise ValueError("A previously saved plan already exists")
    try:
        checkpoint("create-targeted-terraform-plan")
        fast_auth._terraform(
            "plan", "-input=false", "-no-color", "-lock-timeout=60s",
            "-target=" + POOL,
            "-target=aws_lambda_permission.recovery",
            "-target=aws_iam_role_policy.recovery",
            "-var=enable_test_signup=" + str(control.signup_policy(values)).lower(),
            "-out=" + str(plan_path),
        )
        checkpoint("read-targeted-terraform-plan")
        plan = json.loads(fast_auth._terraform("show", "-json", str(plan_path)))
        checkpoint("audit-targeted-terraform-plan")
        _safe_hook_shape(plan)
        try:
            verify_plan(plan, pool_id, expected_hook_arn=expected_arn())
        except ValueError as error:
            reason = str(error)
            if reason in SAFE_REJECTION_REASONS:
                print("STAGING_RECOVERY_GUARD=" + reason, flush=True)
            raise
        # The merge-triggered diagnostic has no apply path. A reviewed,
        # explicitly marked main push can only report guard status.
        if os.environ.get("STAGING_RECOVERY_DRY_RUN") == "true":
            checkpoint("diagnostic-only-no-aws-mutations")
            print("PASS: recovery Terraform plan meets allowed constraints; no apply attempted", flush=True)
            return
        checkpoint("recheck-live-environment")
        current, current_config = fast_frontend.live()
        if current != values or current_config != config or live_attached(pool_id):
            raise ValueError("Staging changed after recovery plan audit")
        checkpoint("apply-reviewed-saved-plan")
        fast_auth._terraform("apply", "-input=false", "-no-color", str(plan_path))
        checkpoint("verify-live-after-apply")
        actual, actual_config = fast_frontend.live()
        if actual != values or actual_config != config:
            raise ValueError("Staging resources changed during recovery attachment")
        verify_live(pool_id)
        checkpoint("complete")
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
