"""Fail-closed gate for the exact three-resource permanent Lightsail repair."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Mapping

from .repair_review import (
    FINAL,
    EXISTING,
    REPAIR_CREATES,
    check_catalog_and_external_budget,
    review_plan,
)
from .review import PROVIDER_NAME, Refused, Settings, check_source, digest, require

REPOSITORY = "HamedGithubforwork/QuizForge-AI"
WORKFLOW = ".github/workflows/lightsail-production-repair-activation.yml"
CONFIRMATION = "ACTIVATE EXACT THREE-RESOURCE LIGHTSAIL REPAIR"
RESULT = Path("lightsail-repair-activation-results/summary.json")
CATALOG = Path("lightsail-repair-activation-results/catalog.json")
INSTANCE_NAME = "quizforge-production-lightsail-server"
STATIC_IP_NAME = "quizforge-production-lightsail"


def trusted(env: Mapping[str, str]) -> None:
    require(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "UNTRUSTED_INVOCATION")
    require(env.get("GITHUB_REF") == "refs/heads/main", "UNTRUSTED_INVOCATION")
    require(env.get("GITHUB_REPOSITORY") == REPOSITORY, "UNTRUSTED_INVOCATION")
    require(
        env.get("GITHUB_WORKFLOW_REF") == f"{REPOSITORY}/{WORKFLOW}@refs/heads/main",
        "UNTRUSTED_INVOCATION",
    )
    sha = env.get("GITHUB_SHA", "")
    require(bool(re.fullmatch(r"[0-9a-f]{40}", sha)), "UNTRUSTED_WORKFLOW_REVISION")
    require(env.get("GITHUB_WORKFLOW_SHA") == sha, "UNTRUSTED_WORKFLOW_REVISION")
    require(env.get("TF_WORKSPACE", "default") == "default", "NONDEFAULT_WORKSPACE")
    require(not env.get("ACTIONS_STEP_DEBUG") and not env.get("RUNNER_DEBUG"),
            "DEBUG_MODE_REFUSED")
    require(env.get("QF_REPAIR_CONFIRMATION", "") == CONFIRMATION,
            "CONFIRMATION_MISMATCH")


def settings() -> Settings:
    return Settings.from_env(os.environ)


def base_report() -> dict[str, Any]:
    return {
        "schema": 1,
        "operation": "three_resource_repair_activate",
        "result": "blocked_no_apply_attempted",
        "apply_attempted": False,
        "terraform_apply_completed": False,
        "final_infrastructure_verified": False,
        "repair_manifest_sha256": "",
        "creates": 0,
        "updates": 0,
        "deletes": 0,
        "replacements": 0,
        "dns_changes_performed": False,
        "application_deployment_performed": False,
        "public_signup_enabled": False,
        "ai_enabled": False,
    }


def read_report() -> dict[str, Any]:
    if RESULT.is_file():
        return json.loads(RESULT.read_text(encoding="utf-8"))
    return base_report()


def write_report(value: dict[str, Any], cfg: Settings | None = None) -> None:
    raw = json.dumps(value, indent=2, sort_keys=True) + "\n"
    if cfg is not None:
        for private in (
            cfg.role,
            cfg.account,
            cfg.state_bucket,
            cfg.email,
            cfg.ssh_key,
            cfg.admin_cidr,
        ):
            require(private not in raw, "PUBLIC_SUMMARY_REDACTION_FAILED")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    tmp = RESULT.with_suffix(".tmp")
    tmp.write_text(raw, encoding="utf-8")
    tmp.replace(RESULT)


def fail(report: dict[str, Any], code: str) -> None:
    if report.get("terraform_apply_completed"):
        report["result"] = "repair_apply_completed_readback_not_verified"
    elif report.get("apply_attempted"):
        report["result"] = "repair_apply_failed_possible_partial_resources"
    else:
        report["result"] = "blocked_no_apply_attempted"
    report["error_code"] = (
        code if re.fullmatch(r"[A-Z0-9_]{1,80}", code)
        else "REPAIR_ACTIVATION_REFUSED"
    )


def preflight() -> None:
    env = dict(os.environ)
    trusted(env)
    current = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    require(current == env["GITHUB_SHA"], "WORKFLOW_CHECKOUT_MISMATCH")
    cfg = settings()
    check_source(Path.cwd())
    write_report(base_report(), cfg)


def verify_catalog() -> None:
    """Run the existing catalog/budget checks under the activation workflow trust boundary."""
    env = dict(os.environ)
    trusted(env)
    current = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    require(current == env["GITHUB_SHA"], "WORKFLOW_CHECKOUT_MISMATCH")
    cfg = settings()
    check_source(Path.cwd())
    value = check_catalog_and_external_budget(cfg)

    raw = json.dumps(value, indent=2, sort_keys=True) + "\n"
    for private in (
        cfg.role,
        cfg.account,
        cfg.state_bucket,
        cfg.email,
        cfg.ssh_key,
        cfg.admin_cidr,
    ):
        require(private not in raw, "PUBLIC_SUMMARY_REDACTION_FAILED")
    CATALOG.parent.mkdir(parents=True, exist_ok=True)
    tmp = CATALOG.with_suffix(".tmp")
    tmp.write_text(raw, encoding="utf-8")
    tmp.replace(CATALOG)


def review_saved_plan(plan_json: str, catalog_json: str, plan_binary: str) -> None:
    cfg = settings()
    check_source(Path.cwd())
    plan = json.loads(Path(plan_json).read_text(encoding="utf-8"))
    catalog = json.loads(Path(catalog_json).read_text(encoding="utf-8"))
    manifest = review_plan(plan, cfg, catalog)
    binary = Path(plan_binary)
    require(binary.is_file() and binary.stat().st_size > 0, "SAVED_PLAN_MISSING")

    report = read_report()
    report.update({
        "result": "repair_plan_revalidated_no_apply_yet",
        "repair_manifest_sha256": digest(manifest),
        "creates": manifest["creates"],
        "updates": manifest["updates"],
        "deletes": manifest["deletes"],
        "replacements": manifest["replacements"],
        "approved_refresh_drift_entries": manifest["approved_refresh_drift_entries"],
        "expected_existing_resources": len(EXISTING),
        "expected_final_resources": len(FINAL),
    })
    require(report["creates"] == len(REPAIR_CREATES), "REPAIR_CREATE_COUNT_MISMATCH")
    require(report["updates"] == 0 and report["deletes"] == 0
            and report["replacements"] == 0, "REPAIR_PLAN_NOT_CREATE_ONLY")

    # Read the plan once here so a missing/empty plan cannot pass review.
    hashlib.sha256(binary.read_bytes()).hexdigest()
    write_report(report, cfg)


def _managed_addresses(root: Mapping[str, Any]) -> set[str]:
    return {
        str(item.get("address"))
        for item in root.get("resources", [])
        if isinstance(item, Mapping) and item.get("mode") == "managed"
    }


def _changed_top_level_attributes(change: Mapping[str, Any]) -> set[str]:
    before = change.get("before")
    after = change.get("after")
    require(
        isinstance(before, Mapping) and isinstance(after, Mapping),
        "FINAL_REFRESH_VALUES_MISSING",
    )
    return {
        str(key)
        for key in set(before) | set(after)
        if isinstance(key, str) and before.get(key) != after.get(key)
    }


def read_final_live_lightsail(cfg: Settings) -> dict[str, Any]:
    """Read the final Lightsail contract without publishing either IP address."""
    import boto3

    lightsail = boto3.client("lightsail", region_name="ca-central-1")
    instance = lightsail.get_instance(instanceName=INSTANCE_NAME)["instance"]
    static_ip = lightsail.get_static_ip(staticIpName=STATIC_IP_NAME)["staticIp"]
    port_states = lightsail.get_instance_port_states(
        instanceName=INSTANCE_NAME
    ).get("portStates", [])

    normalized_ports = {
        (
            item.get("fromPort"),
            item.get("toPort"),
            item.get("protocol"),
            tuple(sorted(item.get("cidrs") or [])),
            tuple(sorted(item.get("ipv6Cidrs") or [])),
            tuple(sorted(item.get("cidrListAliases") or [])),
        )
        for item in port_states
        if isinstance(item, Mapping)
    }
    expected_ports = {
        (22, 22, "tcp", (cfg.admin_cidr,), (), ()),
        (80, 80, "tcp", ("0.0.0.0/0",), (), ()),
        (443, 443, "tcp", ("0.0.0.0/0",), (), ()),
    }

    instance_public_ip = instance.get("publicIpAddress")
    static_public_ip = static_ip.get("ipAddress")
    return {
        "summary": {
            "instance_exists": True,
            "static_ip_exists": True,
            "instance_blueprint_expected": instance.get("blueprintId") == "ubuntu_24_04",
            "instance_bundle_expected": instance.get("bundleId") == "small_3_0",
            "instance_availability_zone_expected": (
                instance.get("location", {}).get("availabilityZone") == "ca-central-1a"
            ),
            "instance_reports_static_ip": instance.get("isStaticIp") is True,
            "static_ip_attached_to_expected_instance": (
                static_ip.get("attachedTo") == INSTANCE_NAME
            ),
            "instance_public_ip_matches_static_ip": (
                isinstance(instance_public_ip, str)
                and bool(instance_public_ip)
                and instance_public_ip == static_public_ip
            ),
            "public_ports_contract_ok": normalized_ports == expected_ports,
        },
        "_instance_public_ip": instance_public_ip,
        "_static_public_ip": static_public_ip,
        "_instance_is_static_ip": instance.get("isStaticIp"),
    }


def _validate_final_refresh_drift(
    plan: Mapping[str, Any],
    cfg: Settings,
    live: Mapping[str, Any] | None = None,
) -> int:
    deferred = plan.get("deferred_changes")
    invocations = plan.get("action_invocations")
    require(not deferred, "FINAL_DEFERRED_CHANGE_REFUSED")
    require(not invocations, "FINAL_ACTION_INVOCATION_REFUSED")

    if live is None:
        live = read_final_live_lightsail(cfg)
    summary = live.get("summary")
    require(isinstance(summary, Mapping), "FINAL_LIVE_READBACK_MISSING")
    require(
        summary.get("instance_exists") is True
        and summary.get("static_ip_exists") is True
        and summary.get("instance_blueprint_expected") is True
        and summary.get("instance_bundle_expected") is True
        and summary.get("instance_availability_zone_expected") is True
        and summary.get("instance_reports_static_ip") is True
        and summary.get("static_ip_attached_to_expected_instance") is True
        and summary.get("instance_public_ip_matches_static_ip") is True
        and summary.get("public_ports_contract_ok") is True,
        "FINAL_LIGHTSAIL_LIVE_CONTRACT_MISMATCH",
    )

    drift = plan.get("resource_drift")
    if not drift:
        return 0
    require(isinstance(drift, list) and len(drift) == 1, "FINAL_REFRESH_DRIFT_MISMATCH")
    item = drift[0]
    require(isinstance(item, Mapping), "FINAL_REFRESH_DRIFT_MISMATCH")
    require(
        item.get("address") == "aws_lightsail_instance.server"
        and item.get("mode") == "managed"
        and item.get("provider_name") == PROVIDER_NAME
        and not item.get("previous_address")
        and not item.get("deposed"),
        "FINAL_REFRESH_DRIFT_MISMATCH",
    )
    change = item.get("change")
    require(isinstance(change, Mapping), "FINAL_REFRESH_DRIFT_MISMATCH")
    require(
        change.get("actions") == ["update"]
        and not change.get("replace_paths")
        and not change.get("importing"),
        "FINAL_REFRESH_DRIFT_MISMATCH",
    )
    require(
        _changed_top_level_attributes(change)
        == {"is_static_ip", "public_ip_address", "tags"},
        "FINAL_REFRESH_FIELDS_MISMATCH",
    )

    before = change["before"]
    after = change["after"]
    require(
        before.get("is_static_ip") is False
        and after.get("is_static_ip") is True
        and live.get("_instance_is_static_ip") is True,
        "FINAL_STATIC_IP_FLAG_MISMATCH",
    )
    require(
        before.get("tags") is None and after.get("tags") == {},
        "FINAL_INSTANCE_TAG_REFRESH_MISMATCH",
    )

    before_ip = before.get("public_ip_address")
    after_ip = after.get("public_ip_address")
    live_instance_ip = live.get("_instance_public_ip")
    live_static_ip = live.get("_static_public_ip")
    require(
        isinstance(before_ip, str)
        and bool(before_ip)
        and isinstance(after_ip, str)
        and bool(after_ip)
        and before_ip != after_ip
        and after_ip == live_instance_ip
        and after_ip == live_static_ip
        and before_ip != live_instance_ip
        and before_ip != live_static_ip,
        "FINAL_PUBLIC_IP_REFRESH_MISMATCH",
    )
    return 1


def review_final_plan(
    plan: dict[str, Any],
    cfg: Settings,
    catalog: dict[str, Any],
    live: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Require all 18 final resources to be no-op, then reuse the repair safety contract."""
    prior = plan.get("prior_state", {}).get("values", {}).get("root_module", {})
    require(isinstance(prior, Mapping) and not prior.get("child_modules"),
            "FINAL_STATE_SHAPE_MISMATCH")
    require(_managed_addresses(prior) == set(FINAL), "FINAL_STATE_RESOURCE_SET_MISMATCH")

    changes = [
        item for item in plan.get("resource_changes", [])
        if isinstance(item, Mapping) and item.get("mode") == "managed"
    ]
    require({item.get("address") for item in changes} == set(FINAL),
            "FINAL_PLAN_RESOURCE_SET_MISMATCH")
    for item in changes:
        require(item.get("provider_name") == PROVIDER_NAME, "UNEXPECTED_PROVIDER")
        change = item.get("change")
        require(isinstance(change, Mapping), "FINAL_PLAN_CHANGE_MISSING")
        require(
            change.get("actions") == ["no-op"]
            and isinstance(change.get("before"), Mapping)
            and isinstance(change.get("after"), Mapping)
            and not change.get("replace_paths")
            and not change.get("importing")
            and not item.get("previous_address")
            and not item.get("deposed"),
            "FINAL_PLAN_NOT_ALL_NOOP",
        )

    final_refresh_drift = _validate_final_refresh_drift(plan, cfg, live)

    # Reuse the complete three-create safety reviewer by converting only the
    # already-verified final/no-op shape into its equivalent review fixture.
    # Final refresh-only drift is validated independently above and removed
    # from the synthetic pre-apply review shape.
    synthetic = copy.deepcopy(plan)
    synthetic["applyable"] = True
    synthetic["resource_drift"] = []

    synthetic_prior = (
        synthetic["prior_state"]["values"]["root_module"]["resources"]
    )
    synthetic["prior_state"]["values"]["root_module"]["resources"] = [
        item for item in synthetic_prior
        if item.get("address") in EXISTING
    ]

    for item in synthetic["resource_changes"]:
        if item.get("mode") != "managed":
            continue
        if item.get("address") in REPAIR_CREATES:
            change = item["change"]
            change["actions"] = ["create"]
            change["before"] = None

    repair_manifest = review_plan(synthetic, cfg, catalog)
    return {
        "schema": 1,
        "final_managed_resources": len(FINAL),
        "all_final_resources_noop": len(FINAL),
        "updates": 0,
        "deletes": 0,
        "replacements": 0,
        "approved_refresh_drift_entries": repair_manifest["approved_refresh_drift_entries"],
        "approved_final_refresh_drift_entries": final_refresh_drift,
        "live_lightsail_contract_verified": True,
        "repair_contract_reused": True,
    }


def verify_final(plan_json: str, catalog_json: str) -> None:
    cfg = settings()
    check_source(Path.cwd())
    plan = json.loads(Path(plan_json).read_text(encoding="utf-8"))
    catalog = json.loads(Path(catalog_json).read_text(encoding="utf-8"))
    manifest = review_final_plan(plan, cfg, catalog)

    report = read_report()
    report["final_verification_manifest_sha256"] = digest(manifest)
    report["final_managed_resources"] = manifest["final_managed_resources"]
    report["final_infrastructure_verified"] = True
    report["result"] = "three_resource_repair_completed_and_verified"
    write_report(report, cfg)


def verify_state(path: str) -> None:
    cfg = settings()
    addresses = {
        line.strip()
        for line in Path(path).read_text(encoding="utf-8").splitlines()
        if line.strip()
    }
    require(addresses == set(FINAL), "FINAL_STATE_RESOURCE_SET_MISMATCH")
    write_report(read_report(), cfg)


def mark(name: str) -> None:
    cfg = settings()
    report = read_report()
    if name == "apply-started":
        report["apply_attempted"] = True
        report["result"] = "repair_apply_in_progress_result_unknown"
    elif name == "apply-complete":
        report["apply_attempted"] = True
        report["terraform_apply_completed"] = True
        report["result"] = "repair_apply_completed_readback_pending"
    else:
        raise Refused("MARK_INVALID")
    write_report(report, cfg)


def record_failure(code: str) -> None:
    cfg = None
    try:
        cfg = settings()
    except Exception:
        pass
    report = read_report()
    fail(report, code)
    write_report(report, cfg)


def main() -> int:
    try:
        command = sys.argv[1]
        if command == "preflight" and len(sys.argv) == 2:
            preflight()
        elif command == "catalog" and len(sys.argv) == 2:
            verify_catalog()
        elif command == "review-plan" and len(sys.argv) == 5:
            review_saved_plan(sys.argv[2], sys.argv[3], sys.argv[4])
        elif command == "verify-final-plan" and len(sys.argv) == 4:
            verify_final(sys.argv[2], sys.argv[3])
        elif command == "verify-state" and len(sys.argv) == 3:
            verify_state(sys.argv[2])
        elif command == "mark" and len(sys.argv) == 3:
            mark(sys.argv[2])
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
        print("Permanent Lightsail three-resource repair gate refused.", file=sys.stderr)
        return 1
    except Exception:
        try:
            record_failure("PRIVATE_REPAIR_ACTIVATION_FAILED")
        except Exception:
            RESULT.unlink(missing_ok=True)
        print("Permanent Lightsail three-resource repair gate failed privately.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
