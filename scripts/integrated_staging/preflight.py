"""Fail-closed integrated staging preflight for operator-controlled manual Stop.

Staging persists after a successful run. Never delete an existing session as a
side effect of starting another run, even when an old session's app deadline
has passed. Only explicit Stop or failed-deployment recovery may destroy it.
"""
import os
import re
import sys

import control
from guards import HOST, NAME, permitted_state

REQUIRED_OWNED_RESOURCES = {
    "aws_s3_bucket.site",
    "aws_cognito_user_pool.browser",
    "aws_cloudfront_distribution.site",
}


class PreflightBlocked(ValueError):
    """A non-sensitive, actionable staging preflight rejection."""


def classify(resources, output, account, now=None):
    """Allow only confirmed empty state; refuse every existing staging session."""
    permitted_state(resources)
    if not resources:
        if output:
            raise PreflightBlocked("State has outputs without managed resources; manual inspection required.")
        return "empty"
    if not REQUIRED_OWNED_RESOURCES.issubset(set(resources)):
        raise PreflightBlocked("Incomplete staging state; inspect and use explicit Stop.")
    if not isinstance(output, dict) or output.get("name") != NAME:
        raise PreflightBlocked("Staging state ownership output is missing or mismatched.")
    if not isinstance(account, str) or not re.fullmatch(r"[0-9]{12}", account):
        raise PreflightBlocked("AWS account could not be verified.")
    if (output.get("bucket") != f"{NAME}-{account}"
        or output.get("auth_domain") != f"quizforge-integrated-{account}"
        or output.get("api_url") != "https://" + HOST
        or not isinstance(output.get("pool"), str)
        or not re.fullmatch(r"ca-central-1_[A-Za-z0-9]+", output["pool"])
        or not isinstance(output.get("domain"), str)
        or not re.fullmatch(r"[a-z0-9]+\.cloudfront\.net", output["domain"])):
        raise PreflightBlocked("Staging identifiers do not match the current AWS account and region.")
    raise PreflightBlocked("Staging already exists. Use Quick Update or explicitly Stop staging before deploying another stack.")


def run():
    if (os.environ.get("GITHUB_REF") != "refs/heads/main"
        or os.environ.get("STAGING_PREFLIGHT_ACTION") != "run"):
        raise PreflightBlocked("Staging preflight requires the trusted main-branch run action.")
    signup = control.signup_enabled()
    if os.environ.get("TF_VAR_hostname") != HOST:
        raise PreflightBlocked("This is not the isolated staging API hostname.")
    resources = control.state_resources()
    if resources:
        output = control.values()
        account = control.client("sts").get_caller_identity()["Account"]
    else:
        output, account = None, None
    classify(resources, output, account)
    # An orphaned resource can outlive Terraform state. Independent absence
    # checks also protect against stale DNS, Cognito, RDS, and ALB components.
    control.absent()
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
        summary.write("## Staging preflight ready\n\n")
        summary.write("No existing integrated staging stack; independently verified absent.\n\n")
        summary.write(f"**Create account on staging:** {'ENABLED' if signup else 'DISABLED (default)'}.\n\n")
        summary.write("**Shutdown policy: MANUAL** — after successful deployment select operation `stop` to remove AWS resources and end charges.\n")
    print("PASS: staging is absent and manually managed; no AWS resources deleted before build")
    print("PASS: temporary staging email/password signup " + ("requested" if signup else "disabled (default)"))


if __name__ == "__main__":
    try:
        if sys.argv[1:] != ["run"]:
            raise PreflightBlocked("Unsupported staging preflight operation.")
        run()
    except PreflightBlocked as exc:
        print("Staging preflight blocked: " + str(exc))
        raise SystemExit(1)
    except Exception as exc:
        print("Staging preflight failed safely: " + type(exc).__name__)
        raise SystemExit(1)
