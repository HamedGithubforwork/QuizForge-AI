"""Review and update *only* the password minimum on existing disposable staging.

Production is not touched. Keep MFA and existing Cognito signup policy.
Terraform's saved plan must change one field on one in-place user pool.
"""
import json
import os
from pathlib import Path
import sys

import control
import fast_auth
import fast_frontend
from guards import NAME

BEFORE = 14
AFTER = 8
PASS_FIELDS = ("require_lowercase", "require_uppercase", "require_numbers", "require_symbols")


def password_policy(pool, minimum):
    policies = pool.get("password_policy")
    if not isinstance(policies, list) or len(policies) != 1:
        raise ValueError("Cognito password policy missing in Terraform plan")
    p = policies[0]
    if p.get("minimum_length") != minimum or any(p.get(k) is not True for k in PASS_FIELDS):
        raise ValueError("Unexpected minimum or password complexity in staging plan")
    if p.get("temporary_password_validity_days") != 1:
        raise ValueError("Unexpected staging temporary password lifetime")


def verify_password_plan(plan, expected_pool, *, signup):
    if not isinstance(plan, dict) or plan.get("format_version") is None or plan.get("errored"):
        raise ValueError("Invalid Terraform staging plan")
    if plan.get("resource_drift"):
        raise ValueError("Staging state drift blocks password quick update")
    changed = []
    for resource in plan.get("resource_changes", []):
        actions = resource.get("change", {}).get("actions")
        if resource.get("mode", "managed") != "managed" or actions == ["no-op"]:
            continue
        if resource.get("address") != fast_auth.POOL_ADDRESS or actions != ["update"]:
            raise ValueError("Password quick update would modify unrelated or replacement resource")
        changed.append(resource)
    if len(changed) != 1:
        raise ValueError("Expected exactly one Cognito in-place password update")
    before, after = changed[0]["change"].get("before"), changed[0]["change"].get("after")
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise ValueError("Missing Cognito user-pool configurations")
    if before.get("id") != expected_pool or after.get("id") != expected_pool:
        raise ValueError("Terraform plan targets wrong Cognito user pool")
    # Account linkage, signup, MFA and all other user-pool configuration must
    # remain identical; allow only password-policy replacement in the plan.
    diff = {key for key in set(before) | set(after) if before.get(key) != after.get(key)}
    if diff != {"password_policy"}:
        raise ValueError("Password quick update cannot change any other Cognito field")
    fast_auth._verified_pool(before, signup=signup)
    fast_auth._verified_pool(after, signup=signup)
    password_policy(before, BEFORE)
    password_policy(after, AFTER)
    original, updated = before["password_policy"][0], after["password_policy"][0]
    if {k: v for k, v in original.items() if k != "minimum_length"} != {
        k: v for k, v in updated.items() if k != "minimum_length"
    }:
        raise ValueError("Only password minimum is allowed to change")
    if any(v.get("change", {}).get("actions") != ["no-op"]
           for v in plan.get("output_changes", {}).values()):
        raise ValueError("Staging outputs changed unexpectedly")
    return True


def live_minimum(pool_id):
    p = control.client("cognito-idp").describe_user_pool(UserPoolId=pool_id)["UserPool"]
    if p.get("Name") != NAME:
        raise ValueError("Unexpected Cognito user pool name")
    policy = p.get("Policies", {}).get("PasswordPolicy", {})
    if any(policy.get(key) is not True for key in (
        "RequireLowercase", "RequireUppercase", "RequireNumbers", "RequireSymbols"
    )):
        raise ValueError("Live Cognito password complexity differs")
    if policy.get("TemporaryPasswordValidityDays") != 1:
        raise ValueError("Live Cognito temporary password validity differs")
    length = policy.get("MinimumLength")
    if type(length) is not int or length not in (BEFORE, AFTER):
        raise ValueError("Live password minimum is neither expected value")
    return length


def update():
    if os.environ.get("STAGING_AUTH_UPDATE") != "update_password_policy":
        raise ValueError("Explicit staging password update opt-in is missing")
    values, config = fast_frontend.live()
    pool_id = values["pool"]
    signup = control.signup_policy(values)
    current = live_minimum(pool_id)
    if current == AFTER:
        print("PASS: existing staging Cognito already matches production 8-character minimum")
        return
    keys = fast_auth.EXPECTED_PROOFS
    immutable = {key: values[key] for key in keys}
    temp = Path(os.environ["RUNNER_TEMP"]) / "staging-password-minimum.tfplan"
    if temp.exists():
        raise ValueError("Unexpected existing Terraform plan")
    try:
        fast_auth._terraform(
            "plan", "-input=false", "-no-color", "-lock-timeout=60s",
            "-target=" + fast_auth.POOL_ADDRESS,
            "-var=enable_test_signup=" + str(signup).lower(),
            "-out=" + str(temp),
        )
        plan = json.loads(fast_auth._terraform("show", "-json", str(temp)))
        verify_password_plan(plan, pool_id, signup=signup)
        fresh, new_config = fast_frontend.live()
        if fresh != values or new_config != config or (
            control.signup_policy(fresh) is not signup or live_minimum(pool_id) != BEFORE
        ):
            raise ValueError("Staging changed after reviewing password plan")
        fast_auth._terraform("apply", "-input=false", "-no-color", str(temp))
        final, final_config = fast_frontend.live()
        if ({key: final[key] for key in keys} != immutable
            or final_config != config or control.signup_policy(final) is not signup
            or live_minimum(pool_id) != AFTER):
            raise ValueError("Staging changed unexpectedly during password update")
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as out:
            out.write("## Staging password policy aligned with production\n\n")
            out.write(f"[Open existing staging site]({config['frontend_url']}/)\n\n")
            out.write("Minimum 14 → 8 characters; all four complexity requirements and mandatory TOTP preserved. No other staging resource or production resource changed.\n")
        print("PASS: staged Cognito-only password minimum updated from 14 to 8")
    finally:
        temp.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        if sys.argv[1:] != ["update"]:
            raise ValueError("Unsupported staging password operation")
        update()
    except Exception as exc:
        # Terraform plan/provider messages can expose secret values or state.
        print("Staging password update refused: " + type(exc).__name__)
        raise SystemExit(1)
