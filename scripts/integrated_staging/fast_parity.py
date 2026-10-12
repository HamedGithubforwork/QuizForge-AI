"""Guard an existing disposable staging Cognito transition to production auth policy.

Run only after the password-only update has completed on main. Never create
another pool, modify production, or apply an unreviewed Terraform plan.
"""
import json
import os
from pathlib import Path
import sys

import control
import fast_auth
import fast_frontend
import fast_password
from guards import NAME

CHANGABLE = frozenset({
    "mfa_configuration",
    "account_recovery_setting",
    "auto_verified_attributes",
    "user_attribute_update_settings",
    "verification_message_template",
})
REQUIRED = frozenset({"mfa_configuration", "account_recovery_setting"})


def _account_recovery(pool, expected):
    blocks = pool.get("account_recovery_setting")
    if not isinstance(blocks, list) or len(blocks) != 1:
        raise ValueError("Unexpected Cognito recovery block")
    methods = blocks[0].get("recovery_mechanism")
    if not isinstance(methods, list) or len(methods) != 1:
        raise ValueError("Unexpected Cognito recovery methods")
    if methods[0].get("name") != expected or methods[0].get("priority") != 1:
        raise ValueError("Unexpected Cognito account recovery mechanism")


def _pool(pool, pool_id, *, signup, updated):
    if pool.get("id") != pool_id or pool.get("name") != NAME:
        raise ValueError("Unexpected Cognito pool identity")
    if pool.get("mfa_configuration") != ("OPTIONAL" if updated else "ON"):
        raise ValueError("Unexpected Cognito MFA mode")
    if pool.get("deletion_protection") != "INACTIVE":
        raise ValueError("Parity change must preserve disposable pool boundary")
    if pool.get("username_attributes") != ["email"]:
        raise ValueError("Cognito username mode changed")
    admin = pool.get("admin_create_user_config")
    if not isinstance(admin, list) or len(admin) != 1 or (
        admin[0].get("allow_admin_create_user_only") is not (not signup)
    ):
        raise ValueError("Existing staging signup mode changed")
    totp = pool.get("software_token_mfa_configuration")
    if not isinstance(totp, list) or len(totp) != 1 or totp[0].get("enabled") is not True:
        raise ValueError("Authenticator support changed")
    expected_verified = {"email"} if updated or signup else set()
    if set(pool.get("auto_verified_attributes") or []) != expected_verified:
        raise ValueError("Unexpected email auto-verification policy")
    _account_recovery(pool, "verified_email" if updated else "admin_only")
    fast_password.password_policy(pool, 8)
    if updated:
        update = pool.get("user_attribute_update_settings")
        if not isinstance(update, list) or len(update) != 1 or (
            set(update[0].get("attributes_require_verification_before_update") or []) != {"email"}
        ):
            raise ValueError("Email attribute changes must require verification")
        templates = pool.get("verification_message_template")
        if not isinstance(templates, list) or len(templates) != 1 or (
            templates[0].get("default_email_option") != "CONFIRM_WITH_CODE"
        ):
            raise ValueError("Cognito email confirmation must use codes")


def verify_plan(plan, pool_id, *, signup):
    if not isinstance(plan, dict) or not plan.get("format_version") or plan.get("errored"):
        raise ValueError("Missing or failed Terraform plan")
    if plan.get("resource_drift"):
        raise ValueError("Staging drift blocks in-place auth parity update")
    changes = []
    for resource in plan.get("resource_changes", []):
        if resource.get("mode", "managed") != "managed":
            continue
        action = resource.get("change", {}).get("actions")
        if action == ["no-op"]:
            continue
        if resource.get("address") != fast_auth.POOL_ADDRESS or action != ["update"]:
            raise ValueError("Auth parity cannot change or replace any other resource")
        changes.append(resource)
    if len(changes) != 1:
        raise ValueError("Auth parity requires exactly one existing Cognito pool update")
    before = changes[0]["change"].get("before")
    after = changes[0]["change"].get("after")
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise ValueError("Missing pre/post Cognito plan configurations")
    _pool(before, pool_id, signup=signup, updated=False)
    _pool(after, pool_id, signup=signup, updated=True)
    differences = {k for k in set(before) | set(after) if before.get(k) != after.get(k)}
    if not REQUIRED.issubset(differences) or differences - CHANGABLE:
        raise ValueError("Plan includes missing parity updates or unrelated Cognito changes")
    if any(v.get("change", {}).get("actions") != ["no-op"]
           for v in plan.get("output_changes", {}).values()):
        raise ValueError("Parity update must not change Terraform outputs")
    return True


def live_email_controls(pool_id):
    """Check effective AWS settings rather than trusting Terraform apply output."""
    pool = control.client("cognito-idp").describe_user_pool(UserPoolId=pool_id)["UserPool"]
    if pool.get("Name") != NAME:
        raise ValueError("Effective user pool is not the owned staging pool")
    attrs = pool.get("UserAttributeUpdateSettings", {})
    if set(attrs.get("AttributesRequireVerificationBeforeUpdate") or []) != {"email"}:
        raise ValueError("Live staging email changes are not verification protected")
    template = pool.get("VerificationMessageTemplate", {})
    if template.get("DefaultEmailOption") != "CONFIRM_WITH_CODE":
        raise ValueError("Live staging email confirmation mode differs")
    return True


def update():
    if os.environ.get("STAGING_AUTH_UPDATE") != "align_auth_parity":
        raise ValueError("Missing explicit operator-approved parity action")
    v = control.values()
    if not v or "pool" not in v:
        raise ValueError("No existing staging Cognito pool")
    c = control.client("cognito-idp")
    mode = c.describe_user_pool(UserPoolId=v["pool"])["UserPool"].get("MfaConfiguration")
    if mode == "OPTIONAL":
        _, config = fast_frontend.live()
        if fast_password.live_minimum(v["pool"]) != 8:
            raise ValueError("Existing staging password policy differs")
        live_email_controls(v["pool"])
        print("PASS: existing staging Cognito already has reviewed production auth settings")
        return
    if mode != "ON":
        raise ValueError("Unexpected starting Cognito MFA mode")
    before, config = fast_frontend.live(legacy_auth=True)
    signup = control.signup_policy(before, legacy_auth=True)
    if fast_password.live_minimum(before["pool"]) != 8:
        raise ValueError("Run the password-only Quick Update on main first")
    temp = Path(os.environ["RUNNER_TEMP"]) / "staging-auth-parity.tfplan"
    if temp.exists():
        raise ValueError("Unexpected pre-existing parity plan")
    try:
        fast_auth._terraform(
            "plan", "-input=false", "-no-color", "-lock-timeout=60s",
            "-target=" + fast_auth.POOL_ADDRESS,
            "-var=enable_test_signup=" + str(signup).lower(),
            "-out=" + str(temp),
        )
        plan = json.loads(fast_auth._terraform("show", "-json", str(temp)))
        verify_plan(plan, before["pool"], signup=signup)
        current, current_config = fast_frontend.live(legacy_auth=True)
        if current != before or current_config != config or (
            control.signup_policy(current, legacy_auth=True) is not signup
            or fast_password.live_minimum(before["pool"]) != 8
        ):
            raise ValueError("Staging changed after auditing the saved parity plan")
        fast_auth._terraform("apply", "-input=false", "-no-color", str(temp))
        after, after_config = fast_frontend.live()
        if after != before or after_config != config or (
            control.signup_policy(after) is not signup
            or fast_password.live_minimum(after["pool"]) != 8
        ):
            raise ValueError("Staging identity or configuration changed during parity update")
        live_email_controls(after["pool"])
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
            summary.write("## In-place staging Cognito parity verified\n\n")
            summary.write(f"[Open existing staging site]({config['frontend_url']}/)\n\n")
            summary.write("Optional TOTP and verified-email recovery now match reviewed production policy. Existing pool, identities, database, resources and manual Stop remain unchanged.\n")
        print("PASS: existing Cognito pool updated in place; no replacement or production change")
    finally:
        temp.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        if sys.argv[1:] != ["update"]:
            raise ValueError("Unsupported Cognito parity operation")
        update()
    except Exception as exc:
        # Provider errors/plan text may contain sensitive state; never print.
        print("Staging auth parity refused: " + type(exc).__name__)
        raise SystemExit(1)
