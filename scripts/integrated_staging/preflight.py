"""Fail-closed integrated staging preflight: never build against stale Terraform state.

The only destructive case is an expired, positively identified disposable
integrated-staging stack. Existing active sessions and uncertain/foreign state
require explicit operator intervention and are never destroyed automatically.
"""
from datetime import datetime, timezone
import os
import re
import subprocess
import sys

import control
from guards import HOST, NAME, permitted_state

REQUIRED_OWNED_RESOURCES = {
    "aws_s3_bucket.site",
    "aws_cognito_user_pool.browser",
    "aws_cloudfront_distribution.site",
}
MAX_FUTURE_LEASE_SECONDS = 7300


class PreflightBlocked(ValueError):
    """A non-sensitive, actionable staging preflight rejection."""


def classify(resources, output, account, now=None):
    """Return 'empty' or 'expired'; raise for active/unknown/non-staging state."""
    permitted_state(resources)
    if not resources:
        if output:
            raise PreflightBlocked("State has outputs without any managed resources; manual inspection required.")
        return "empty"
    if not REQUIRED_OWNED_RESOURCES.issubset(set(resources)):
        raise PreflightBlocked("Incomplete staging state cannot be auto-recovered; use the explicit stop workflow.")
    if not isinstance(output, dict) or output.get("name") != NAME:
        raise PreflightBlocked("Terraform staging ownership output missing or mismatched.")
    if not isinstance(account, str) or not re.fullmatch(r"[0-9]{12}", account):
        raise PreflightBlocked("Cloud account identity could not be verified.")
    if (output.get("bucket") != f"{NAME}-{account}"
        or output.get("auth_domain") != f"quizforge-integrated-{account}"
        or output.get("api_url") != "https://" + HOST
        or not isinstance(output.get("pool"), str)
        or not re.fullmatch(r"ca-central-1_[A-Za-z0-9]+", output["pool"])
        or not isinstance(output.get("domain"), str)
        or not re.fullmatch(r"[a-z0-9]+\.cloudfront\.net", output["domain"])):
        raise PreflightBlocked("Staging resource identifiers do not match this account and region.")
    try:
        deadline = datetime.fromisoformat(output["deadline"].replace("Z", "+00:00"))
    except (TypeError, KeyError, ValueError, AttributeError):
        raise PreflightBlocked("Staging lease missing or invalid; cannot auto-destroy.") from None
    if deadline.tzinfo is None:
        raise PreflightBlocked("Staging lease is not timezone-aware.")
    current = now or datetime.now(timezone.utc)
    seconds_remaining = (deadline - current).total_seconds()
    if seconds_remaining > MAX_FUTURE_LEASE_SECONDS:
        raise PreflightBlocked("Staging lease is longer than the authorized maximum.")
    if seconds_remaining > 0:
        raise PreflightBlocked("An active staging lease remains. Use Quick Update, or stop it explicitly; no automatic deletion.")
    return "expired"


def _destroy():
    # Do not log Terraform/provider details: saved state can include OAuth secret data.
    run = subprocess.run(
        ["terraform", f"-chdir={control.TF}", "destroy", "-auto-approve", "-input=false", "-no-color"],
        capture_output=True, text=True, timeout=3300,
    )
    if run.returncode:
        raise PreflightBlocked("Expired disposable staging destruction failed. Use the stop/cleanup workflow.")


def run():
    if (os.environ.get("GITHUB_REF") != "refs/heads/main"
        or os.environ.get("STAGING_PREFLIGHT_ACTION") != "run"):
        raise PreflightBlocked("Staging recovery requires the trusted main-branch run action.")
    # Read the explicitly requested signup policy early; the default must stay off.
    signup = control.signup_enabled()
    if os.environ.get("TF_VAR_hostname") != HOST:
        raise PreflightBlocked("This is not the isolated staging API hostname.")
    resources = control.state_resources()
    if resources:
        output = control.values()
        account = control.client("sts").get_caller_identity()["Account"]
    else:
        output, account = None, None
    mode = classify(resources, output, account)
    if mode == "expired":
        # Avoid reclaiming an active session, even if the lease changed since
        # the first query. AWS changes are serialized by workflow concurrency.
        control.stop_tasks()
        _destroy()
    # Verify exact resource absence, including backups and DNS, before image
    # builds/provisioning. An orphaned stack with no state always fails closed.
    control.absent()
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
        summary.write("## Staging preflight ready\n\n")
        summary.write(f"Previous staging: {'expired isolated stack recovered and independently verified absent' if mode == 'expired' else 'no isolated stack; independently verified absent'}.\n\n")
        summary.write(f"**Create account on staging:** {'ENABLED for this new temporary deployment' if signup else 'DISABLED (default)'}.\n\n")
        summary.write("No production resources or accounts were modified. The new staging pool will be temporary.\n")
    print("PASS: owned expired staging recovered or absent; independent absence verified before image builds")
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
        # Avoid emitting AWS service error bodies or Terraform state in logs.
        print("Staging preflight failed safely: " + type(exc).__name__)
        raise SystemExit(1)
