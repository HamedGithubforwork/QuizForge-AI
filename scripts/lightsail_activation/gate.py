"""Small fail-closed gate for permanent Lightsail activation."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Mapping

from .review import EXPECTED, Refused, Settings, check_source, digest, require, review_plan

REPOSITORY = "HamedGithubforwork/QuizForge-AI"
WORKFLOW = ".github/workflows/lightsail-production-activation.yml"
APPROVED = "494e975cedf232737c76572d28a68263bb1d82beb1461ffc29d895109c761572"
CONFIRMATION = "ACTIVATE PERMANENT LIGHTSAIL ONLY"
RESULT = Path("lightsail-activation-results/summary.json")


def trusted(env: Mapping[str, str], mode: str) -> None:
    require(mode in {"activate", "verify"}, "MODE_INVALID")
    require(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "UNTRUSTED_INVOCATION")
    require(env.get("GITHUB_REF") == "refs/heads/main", "UNTRUSTED_INVOCATION")
    require(env.get("GITHUB_REPOSITORY") == REPOSITORY, "UNTRUSTED_INVOCATION")
    require(env.get("GITHUB_WORKFLOW_REF") == f"{REPOSITORY}/{WORKFLOW}@refs/heads/main",
            "UNTRUSTED_INVOCATION")
    sha = env.get("GITHUB_SHA", "")
    require(bool(re.fullmatch(r"[0-9a-f]{40}", sha)), "UNTRUSTED_WORKFLOW_REVISION")
    require(env.get("GITHUB_WORKFLOW_SHA") == sha, "UNTRUSTED_WORKFLOW_REVISION")
    require(env.get("TF_WORKSPACE", "default") == "default", "NONDEFAULT_WORKSPACE")
    require(not env.get("ACTIONS_STEP_DEBUG") and not env.get("RUNNER_DEBUG"),
            "DEBUG_MODE_REFUSED")
    if mode == "activate":
        require(env.get("QF_REVIEWED_MANIFEST", "") == APPROVED,
                "REVIEWED_MANIFEST_MISMATCH")
        require(env.get("QF_CONFIRMATION", "") == CONFIRMATION, "CONFIRMATION_MISMATCH")


def settings() -> Settings:
    return Settings.from_env(os.environ)


def base_report(mode: str) -> dict:
    return {
        "schema": 1,
        "operation": mode,
        "result": "blocked_no_apply_attempted" if mode == "activate"
                  else "verification_pending_no_apply",
        "apply_attempted": False,
        "terraform_apply_completed": False,
        "infrastructure_settings_verified": False,
        "review_manifest_sha256": "",
        "scheduled_application_deployment": False,
        "dns_changes_performed": False,
        "ai_enabled": False,
    }


def read_report(mode: str) -> dict:
    if RESULT.is_file():
        return json.loads(RESULT.read_text())
    return base_report(mode)


def write_report(value: dict, cfg: Settings | None = None) -> None:
    raw = json.dumps(value, indent=2, sort_keys=True) + "\n"
    if cfg:
        for private in (cfg.role, cfg.account, cfg.state_bucket, cfg.email,
                        cfg.ssh_key, cfg.admin_cidr):
            require(private not in raw, "PUBLIC_SUMMARY_REDACTION_FAILED")
    RESULT.parent.mkdir(exist_ok=True)
    tmp = RESULT.with_suffix(".tmp")
    tmp.write_text(raw)
    tmp.replace(RESULT)


def fail(report: dict, code: str) -> None:
    if report.get("terraform_apply_completed"):
        report["result"] = "apply_completed_readback_not_verified"
    elif report.get("apply_attempted"):
        report["result"] = "apply_failed_possible_partial_resources"
    elif report.get("operation") == "verify":
        report["result"] = "verification_failed_no_apply"
    else:
        report["result"] = "blocked_no_apply_attempted"
    report["error_code"] = code if re.fullmatch(r"[A-Z0-9_]{1,80}", code) else "ACTIVATION_REFUSED"


def preflight(mode: str) -> None:
    env = dict(os.environ)
    trusted(env, mode)
    current = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    require(current == env["GITHUB_SHA"], "WORKFLOW_CHECKOUT_MISMATCH")
    cfg = settings()
    check_source(Path.cwd())
    write_report(base_report(mode), cfg)


def review_saved_plan(plan_json: str, plan_binary: str) -> None:
    cfg = settings()
    check_source(Path.cwd())
    plan = json.loads(Path(plan_json).read_text())
    manifest = review_plan(plan, cfg)
    value = digest(manifest)
    require(value == APPROVED, "REVIEWED_MANIFEST_MISMATCH")
    binary = Path(plan_binary)
    require(binary.is_file() and binary.stat().st_size > 0, "SAVED_PLAN_MISSING")
    report = read_report("activate")
    report.update({
        "review_manifest_sha256": value,
        "creates": manifest["creates"],
        "updates": manifest["updates"],
        "deletes": manifest["deletes"],
        "saved_plan_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "result": "activation_plan_revalidated_no_apply_yet",
    })
    # Binary hash is safe but unnecessary in the public contract.
    report.pop("saved_plan_sha256", None)
    write_report(report, cfg)


def mark(name: str) -> None:
    cfg = settings()
    mode = os.environ.get("QF_OPERATION", "verify")
    report = read_report(mode)
    if name == "apply-started":
        report["apply_attempted"] = True
        report["result"] = "apply_in_progress_result_unknown"
    elif name == "apply-complete":
        report["apply_attempted"] = True
        report["terraform_apply_completed"] = True
        report["result"] = "apply_completed_readback_pending"
    elif name == "verified":
        report["infrastructure_settings_verified"] = True
        report["result"] = ("activation_infrastructure_settings_verified"
                            if report.get("terraform_apply_completed")
                            else "existing_infrastructure_settings_verified")
    else:
        raise Refused("MARK_INVALID")
    write_report(report, cfg)


def verify_state(path: str) -> None:
    cfg = settings()
    addresses = {line.strip() for line in Path(path).read_text().splitlines() if line.strip()}
    require(addresses == set(EXPECTED), "STATE_RESOURCE_SET_MISMATCH")
    write_report(read_report(os.environ.get("QF_OPERATION", "verify")), cfg)


def record_failure(code: str) -> None:
    cfg = None
    try:
        cfg = settings()
    except Exception:
        pass
    mode = os.environ.get("QF_OPERATION", "verify")
    report = read_report(mode)
    fail(report, code)
    write_report(report, cfg)


def main() -> int:
    try:
        command = sys.argv[1]
        if command == "preflight" and len(sys.argv) == 3:
            preflight(sys.argv[2])
        elif command == "review-plan" and len(sys.argv) == 4:
            review_saved_plan(sys.argv[2], sys.argv[3])
        elif command == "mark" and len(sys.argv) == 3:
            mark(sys.argv[2])
        elif command == "verify-state" and len(sys.argv) == 3:
            verify_state(sys.argv[2])
        elif command == "failure" and len(sys.argv) == 3:
            record_failure(sys.argv[2])
        else:
            raise Refused("UNEXPECTED_ARGUMENTS")
        return 0
    except Refused as error:
        try:
            record_failure(str(error))
        except Exception:
            RESULT.unlink(missing_ok=True)
        print("Permanent Lightsail activation gate refused.", file=sys.stderr)
        return 1
    except Exception:
        try:
            record_failure("PRIVATE_OPERATION_FAILED")
        except Exception:
            RESULT.unlink(missing_ok=True)
        print("Permanent Lightsail activation gate failed privately.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
