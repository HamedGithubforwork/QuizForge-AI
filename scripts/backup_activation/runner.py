"""Manual-only orchestration; private plans/logs never become GitHub artifacts."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

from .contract import (
    CANDIDATE, MAIN_SHA256, TEST_SHA256, TERRAFORM, REGION, STATE_KEY, WORKSPACE_PREFIX,
    Settings, Refused, canonical, digest, require, trusted_invocation, review_plan,
    new_report, error_result,
)

STACK = Path("infra/aws/lightsail-backups")


def quiet_git(root: Path, *arguments: str) -> bytes:
    result = subprocess.run(["git", "-C", str(root), *arguments], capture_output=True, timeout=20, check=False)
    require(result.returncode == 0, "SOURCE_GIT_CHECK_FAILED")
    return result.stdout


def check_tree(directory: Path) -> None:
    require(directory.is_dir(), "PINNED_STACK_MISSING")
    main = directory / "main.tf"
    test = directory / "tests/boundaries.tftest.hcl"
    require(main.is_file() and not main.is_symlink() and test.is_file() and not test.is_symlink(),
            "PINNED_SOURCE_MISSING")
    require(hashlib.sha256(main.read_bytes()).hexdigest() == MAIN_SHA256, "PINNED_MAIN_HASH_MISMATCH")
    require(hashlib.sha256(test.read_bytes()).hexdigest() == TEST_SHA256, "PINNED_TEST_HASH_MISMATCH")
    configs = {p.name for p in directory.iterdir() if p.name.endswith((".tf", ".tf.json"))}
    require(configs == {"main.tf"}, "UNEXPECTED_TERRAFORM_CONFIGURATION")
    require(not any(p.name.endswith((".tfvars", ".tfvars.json")) for p in directory.iterdir()),
            "UNEXPECTED_VARIABLE_FILE")
    lock = directory / ".terraform.lock.hcl"
    require(lock.is_file() and not lock.is_symlink(), "PINNED_PROVIDER_LOCK_MISSING")
    text = lock.read_text(encoding="utf-8")
    require('provider "registry.terraform.io/hashicorp/aws"' in text
            and re.search(r'version\s*=\s*"6\.64\.0"', text) is not None,
            "PINNED_PROVIDER_LOCK_MISMATCH")


def check_source(candidate: Path) -> None:
    require(quiet_git(candidate, "rev-parse", "HEAD").decode().strip() == CANDIDATE, "CANDIDATE_SHA_MISMATCH")
    quiet_git(candidate, "diff", "--exit-code", "HEAD", "--", str(STACK))
    require(not quiet_git(candidate, "ls-files", "--others", "--exclude-standard", "--", str(STACK)),
            "UNTRACKED_CANDIDATE_FILES")
    check_tree(candidate / STACK)


def terminate_group(process: subprocess.Popen) -> None:
    for sig, delay in ((signal.SIGINT, 30), (signal.SIGTERM, 10), (signal.SIGKILL, 5)):
        if process.poll() is not None:
            return
        try:
            os.killpg(process.pid, sig)
            process.wait(timeout=delay)
        except ProcessLookupError:
            return
        except subprocess.TimeoutExpired:
            continue


class Operations:
    def __init__(self, candidate: Path, settings: Settings, private: Path, env: dict[str, str]):
        from .access import Sessions
        self.candidate, self.settings, self.private = candidate, settings, private
        self.work = private / "stack"
        shutil.copytree(candidate / STACK, self.work, ignore=shutil.ignore_patterns(".terraform"))
        self.sessions = Sessions(settings, private, env)
        self.plan_path = private / "activation.tfplan"
        self.plan_hash = ""
        self.lock_hash = hashlib.sha256((self.work / ".terraform.lock.hcl").read_bytes()).hexdigest()
        self.plan_started = 0.0

    def prepare(self, write=False, include_state=True):
        self.sessions.prepare(write=write, include_state=include_state)

    def empty_state(self):
        from .readback import empty_state
        empty_state(self.sessions, self.settings)

    def inventory(self):
        from .readback import inventory
        inventory(self.sessions, self.settings)

    def tf(self, args: list[str], label: str, timeout=300, allowed=(0,), output: Path | None = None) -> Path:
        out = output or self.private / (label + ".stdout")
        err = self.private / (label + ".stderr")
        # Files and their directory are private; never print them on failure.
        with out.open("wb") as stdout, err.open("wb") as stderr:
            process = subprocess.Popen(["terraform", f"-chdir={self.work}", *args],
                stdout=stdout, stderr=stderr, env=self.sessions.terraform_env(), start_new_session=True)
            try:
                code = process.wait(timeout=timeout)
            except BaseException:
                terminate_group(process)
                raise Refused("TERRAFORM_INTERRUPTED_RESULT_UNKNOWN") from None
        require(code in allowed, "TERRAFORM_COMMAND_FAILED")
        return out

    def plan(self) -> dict:
        check_tree(self.work)
        version = json.loads(self.tf(["version", "-json"], "version").read_text())
        require(version.get("terraform_version") == TERRAFORM, "TERRAFORM_VERSION_MISMATCH")
        self.tf(["init", "-input=false", "-reconfigure", "-lockfile=readonly",
            f"-backend-config=bucket={self.settings.state_bucket}", f"-backend-config=key={STATE_KEY}",
            f"-backend-config=region={REGION}", "-backend-config=encrypt=true",
            "-backend-config=use_lockfile=true", "-backend-config=profile=qf-state",
            f"-backend-config=workspace_key_prefix={WORKSPACE_PREFIX}"], "init")
        backend = json.loads((self.private / "tfdata/terraform.tfstate").read_text())["backend"]
        cfg = backend["config"]
        require(backend["type"] == "s3" and cfg["bucket"] == self.settings.state_bucket
                and cfg["key"] == STATE_KEY and cfg["region"] == REGION
                and cfg["encrypt"] is True and cfg["use_lockfile"] is True
                and cfg["profile"] == "qf-state" and cfg["workspace_key_prefix"] == WORKSPACE_PREFIX,
                "BACKEND_BINDING_MISMATCH")
        self.plan_started = time.monotonic()
        self.tf(["plan", "-input=false", "-lock=true", "-lock-timeout=60s", "-detailed-exitcode",
                 f"-out={self.plan_path}"], "plan", allowed=(2,))
        self.plan_hash = hashlib.sha256(self.plan_path.read_bytes()).hexdigest()
        self.plan_path.chmod(0o400)
        data = self.tf(["show", "-json", str(self.plan_path)], "show-plan")
        return json.loads(data.read_text())

    def same_saved_plan(self) -> None:
        require(bool(self.plan_hash) and time.monotonic() - self.plan_started <= 900, "SAVED_PLAN_EXPIRED")
        require(hashlib.sha256(self.plan_path.read_bytes()).hexdigest() == self.plan_hash, "SAVED_PLAN_CHANGED")
        check_source(self.candidate)
        check_tree(self.work)
        require(hashlib.sha256((self.work / ".terraform.lock.hcl").read_bytes()).hexdigest() == self.lock_hash,
                "PROVIDER_LOCK_CHANGED")

    def apply(self) -> None:
        # No new plan, targeting, import, state push, unlock, destroy, or retry.
        self.same_saved_plan()
        self.tf(["apply", "-input=false", "-lock=true", "-lock-timeout=60s", str(self.plan_path)],
                "apply", timeout=600)

    def verify(self) -> dict:
        from .readback import verify
        check_tree(self.work)
        return verify(self.sessions, self.settings)


def execute(mode: str, settings: Settings, ops, reviewed_digest: str, report: dict, checkpoint=lambda: None) -> None:
    """Injectable orchestration. PR tests exercise this without credentials."""
    try:
        require(mode in {"inspect", "activate", "verify"}, "MODE_INVALID")
        ops.prepare(write=False, include_state=(mode != "verify"))
        if mode == "verify":
            report.update(ops.verify())
            report["result"] = "existing_infrastructure_settings_verified"
            checkpoint()
            return
        ops.empty_state()
        ops.inventory()
        manifest = review_plan(ops.plan(), settings)
        report["review_manifest"] = manifest
        report["review_manifest_sha256"] = digest(manifest)
        report["result"] = "inspection_passed_no_apply"
        checkpoint()
        if mode == "inspect":
            return
        require(mode == "activate", "MODE_INVALID")
        require(reviewed_digest == report["review_manifest_sha256"], "REVIEWED_MANIFEST_MISMATCH")
        ops.same_saved_plan()
        # Recheck with read-only sessions immediately before requesting writes.
        ops.empty_state()
        ops.inventory()
        ops.prepare(write=True, include_state=True)
        # The saved binary is rechecked after acquiring the two write sessions.
        ops.same_saved_plan()
        report["apply_attempted"] = True
        report["result"] = "apply_in_progress_result_unknown"
        checkpoint()
        ops.apply()
        report["terraform_apply_completed"] = True
        report["result"] = "apply_completed_readback_pending"
        checkpoint()
        # Discard write profiles for subsequent operations; do not renew them.
        ops.prepare(write=False, include_state=False)
        report.update(ops.verify())
        report["result"] = "activation_infrastructure_settings_verified"
        checkpoint()
    except BaseException:
        error_result(report)
        checkpoint()
        raise


def write_report(path: Path, report: dict, settings: Settings | None = None) -> None:
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if settings:
        require(not any(value in text for value in (
            settings.role, settings.account, settings.state_bucket, settings.email)), "PUBLIC_SUMMARY_REDACTION_FAILED")
    path.parent.mkdir(exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def main() -> int:
    root = Path.cwd()
    candidate = root / "candidate"
    if sys.argv[1:] == ["check-source"]:
        try:
            check_source(candidate)
            print("Pinned backup source checks completed; no cloud operations requested.")
            return 0
        except Exception:
            print("Pinned backup source check refused; Work must reconcile the source snapshot.", file=sys.stderr)
            return 1
    env = dict(os.environ)
    mode = env.get("QF_OPERATION", "inspect")
    report = new_report(mode)
    path = root / "backup-activation-results/summary.json"
    settings = None
    code = 1
    old_umask = os.umask(0o077)
    try:
        require(len(sys.argv) == 1, "UNEXPECTED_ARGUMENTS")
        trusted_invocation(env, mode)
        require(quiet_git(root, "rev-parse", "HEAD").decode().strip() == env["GITHUB_SHA"],
                "WORKFLOW_CHECKOUT_MISMATCH")
        settings = Settings.from_env(env)
        # For activation, validate write-policy sizes before ANY cloud requests.
        if mode == "activate":
            from .access import resource_policy, state_policy
            resource_policy(settings, write=True)
            state_policy(settings, write=True)
        check_source(candidate)
        write_report(path, report, settings)
        with tempfile.TemporaryDirectory(prefix="qf-backup-private-", dir=env.get("RUNNER_TEMP")) as directory:
            private = Path(directory)
            private.chmod(0o700)
            ops = Operations(candidate, settings, private, env)
            execute(mode, settings, ops, env.get("QF_REVIEWED_MANIFEST", ""), report,
                    checkpoint=lambda: write_report(path, report, settings))
        code = 0
    except BaseException as error:
        error_result(report)
        report["error_code"] = str(error) if isinstance(error, Refused) else "PRIVATE_OPERATION_FAILED"
        # A new provider error never becomes public text, even when it contains
        # an ARN, the selected recipient, a signed request, or Terraform output.
        if not re.fullmatch(r"[A-Z_]{1,80}", report["error_code"]):
            report["error_code"] = "PRIVATE_OPERATION_FAILED"
    finally:
        try:
            write_report(path, report, settings)
            summary = env.get("GITHUB_STEP_SUMMARY")
            if summary:
                with Path(summary).open("a", encoding="utf-8") as output:
                    output.write("## Retained backup verification\n\n```json\n")
                    output.write(path.read_text())
                    output.write("```\n\nInfrastructure checks do not establish backup recovery or inbox delivery.\n")
        except Exception:
            # Do not publish a partially sanitized report.
            path.unlink(missing_ok=True)
            code = 1
        os.umask(old_umask)
    print("Backup workflow finished; review the non-sensitive summary. Raw diagnostics were not published.")
    return code


if __name__ == "__main__":
    def interrupted(signum, frame):
        raise Refused("WORKFLOW_INTERRUPTED_RESULT_UNKNOWN")
    signal.signal(signal.SIGTERM, interrupted)
    sys.exit(main())
