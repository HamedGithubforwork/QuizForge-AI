"""One bounded Cognito change on an existing, healthy disposable staging pool.

No frontend, database, production, or unrelated infrastructure operations.
Uses a saved Terraform plan, refuses replacements and non-Cognito mutations, and
never logs the potentially sensitive local Terraform plan or state.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

import control
import fast_frontend
from guards import NAME

POOL_ADDRESS = "aws_cognito_user_pool.browser"
ALLOWED_DIFF_KEYS = frozenset({
    "admin_create_user_config",
})
EXPECTED_PROOFS = frozenset({"name", "pool", "client", "domain", "bucket", "deadline"})


def _verified_pool(pool, *, signup):
    if pool.get("name") != NAME or pool.get("mfa_configuration") != "OPTIONAL":
        raise ValueError("Unexpected staging Cognito pool or MFA policy in plan")
    attrs = pool.get("username_attributes")
    if attrs != ["email"]:
        raise ValueError("Unexpected staging Cognito username attributes")
    admin = pool.get("admin_create_user_config")
    if not isinstance(admin, list) or len(admin) != 1 or (
        admin[0].get("allow_admin_create_user_only") is not (not signup)
    ):
        raise ValueError("Unexpected Cognito public registration plan")
    if set(pool.get("auto_verified_attributes") or []) != {"email"}:
        raise ValueError("Signup email verification must match reviewed staging policy")
    mfa = pool.get("software_token_mfa_configuration")
    if not isinstance(mfa, list) or len(mfa) != 1 or mfa[0].get("enabled") is not True:
        raise ValueError("Authenticator MFA must stay enabled")
    if pool.get("deletion_protection") != "INACTIVE":
        raise ValueError("Disposable staging deletion protection changed")


def verify_plan(plan, expected_pool_id):
    """Require a *single in-place* update with only the two signup fields.

    Other Terraform-managed resources, infrastructure replacements, or state
    refresh drift are always refused. Audit the raw JSON only in process.
    """
    if plan.get("format_version") is None or plan.get("errored"):
        raise ValueError("Invalid Terraform staging plan")
    if plan.get("resource_drift"):
        raise ValueError("Terraform detected unmanaged staging drift")
    changes = []
    for item in plan.get("resource_changes", []):
        actions = item.get("change", {}).get("actions")
        if actions == ["no-op"]:
            continue
        if item.get("mode", "managed") != "managed":
            continue  # Terraform read-only data sources are not writes.
        if item.get("address") != POOL_ADDRESS or actions != ["update"]:
            raise ValueError("Fast auth would change an unrelated or replacement resource")
        changes.append(item)
    if len(changes) != 1:
        raise ValueError("Fast auth requires exactly one Cognito pool update")
    change = changes[0]["change"]
    before, after = change.get("before"), change.get("after")
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise ValueError("Terraform pool plan must show both configurations")
    if before.get("id") != expected_pool_id or after.get("id") != expected_pool_id:
        raise ValueError("Plan targets a different Cognito user pool")
    changed = {key for key in set(before) | set(after) if before.get(key) != after.get(key)}
    if changed != ALLOWED_DIFF_KEYS:
        raise ValueError("Only reviewed registration setting may change")
    if changed - ALLOWED_DIFF_KEYS:
        raise ValueError("Plan changes unrelated Cognito configuration")
    _verified_pool(before, signup=False)
    _verified_pool(after, signup=True)
    if plan.get("output_changes") and any(
        item.get("actions") != ["no-op"] for item in (
            output.get("change", {}) for output in plan["output_changes"].values()
        )
    ):
        raise ValueError("Fast auth must not modify staging outputs")
    return True


def _terraform(*args):
    # Captured outputs can include state/provider diagnostics. No output or
    # sensitive plan data is ever written to public CI logs.
    return subprocess.run(
        ["terraform", f"-chdir={control.TF}", *args],
        check=True, capture_output=True, text=True,
    ).stdout


def enable():
    if os.environ.get("STAGING_AUTH_UPDATE") != "enable_test_signup":
        raise ValueError("Missing exact operator-approved staging auth action")
    values, config = fast_frontend.live()
    if control.signup_policy(values):
        raise ValueError("Temporary signup is already enabled for this staging pool")
    pool_id = values["pool"]
    baseline = {key: values[key] for key in EXPECTED_PROOFS}
    temp = Path(os.environ["RUNNER_TEMP"]) / "staging-auth-signup.tfplan"
    if temp.exists():
        raise ValueError("Unexpected existing Terraform staging plan")
    try:
        _terraform(
            "plan", "-input=false", "-no-color", "-lock-timeout=60s",
            "-target=" + POOL_ADDRESS,
            "-var=enable_test_signup=true", "-out=" + str(temp),
        )
        document = json.loads(_terraform("show", "-json", str(temp)))
        verify_plan(document, pool_id)
        fresh, new_config = fast_frontend.live()
        if control.signup_policy(fresh) or fresh != values or new_config != config:
            raise ValueError("Staging environment changed after plan verification")
        _terraform("apply", "-input=false", "-no-color", str(temp))
        final, final_config = fast_frontend.live()
        if {key: final[key] for key in EXPECTED_PROOFS} != baseline or final_config != config:
            raise ValueError("Staging identifiers changed during guarded Cognito update")
        if not control.signup_policy(final):
            raise ValueError("Email-verified signup not active in Cognito after apply")
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
            summary.write("## Temporary staging account creation enabled\\n\\n")
            summary.write(f"[Open the existing staging website]({config['frontend_url']}/)\\n\\n")
            summary.write("Cognito Create account now supports email confirmation and optional authenticator MFA. No database, website, production, or lease change.\\n\\n")
            summary.write("Account creation may be limited by Cognito default email delivery quotas. Staging cleanup will remove these accounts.\\n")
        print("PASS: reviewed, in-place Cognito-only staging signup configuration applied and verified")
    finally:
        temp.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        if sys.argv[1:] != ["enable"]:
            raise ValueError("Unsupported fast staging auth operation")
        enable()
    except Exception as error:
        # Do not leak provider responses, Terraform plan, credentials or tokens.
        print("Fast staging auth update refused: " + type(error).__name__)
        raise SystemExit(1)
