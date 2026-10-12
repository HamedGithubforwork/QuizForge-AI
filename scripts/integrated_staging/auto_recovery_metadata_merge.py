"""Authorize exactly one reviewed diagnostics-only main merge.

No AWS credentials are available at this stage. An unrelated push, re-run with
a different SHA, or modified/old request must never run cloud diagnostics.
"""
import json
import os
from pathlib import Path

from auto_parity_merge import REPOSITORY, SHA, command

MARKER = ".github/staging-update-requests/recovery-diagnostic-pr-568.json"
PR = 568
REQUEST = {
    "operation": "diagnose_recovery_hook",
    "pull_request": PR,
    "environment": "quizforge-integrated-staging",
    "mode": "read-only-once-after-reviewed-merge",
}


def authorize(event, changed, prs, request):
    if (event.get("repository", {}).get("full_name") != REPOSITORY
            or event.get("ref") != "refs/heads/main"):
        raise ValueError("Unexpected branch or repository")
    before, after = event.get("before"), event.get("after")
    if not all(isinstance(s, str) and SHA.fullmatch(s) and s != "0" * 40
               for s in (before, after)) or before == after:
        raise ValueError("Invalid trusted merge boundary")
    if changed != [f"A\t{MARKER}"] or request != REQUEST:
        raise ValueError("Unapproved diagnostics request")
    if not isinstance(prs, list) or not any(
        isinstance(pr, dict)
        and pr.get("number") == PR
        and pr.get("merged_at")
        and pr.get("merge_commit_sha") == after
        and pr.get("base", {}).get("ref") == "main"
        and pr.get("head", {}).get("repo", {}).get("full_name") == REPOSITORY
        for pr in prs
    ):
        raise ValueError("Expected merged PR #568 is not the main push")
    return True


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    if (os.environ.get("GITHUB_REPOSITORY") != REPOSITORY
            or os.environ.get("GITHUB_EVENT_NAME") != "push"
            or os.environ.get("GITHUB_SHA") != event.get("after")):
        raise ValueError("Untrusted job context")
    diff = command("git", "diff", "--name-status", event["before"],
                   event["after"], "--", MARKER).splitlines()
    prs = json.loads(command(
        "gh", "api", f"repos/{REPOSITORY}/commits/{event['after']}/pulls",
    ))
    request = json.loads(Path(MARKER).read_text(encoding="utf-8"))
    authorize(event, diff, prs, request)
    print("PASS: one reviewed merge authorized read-only recovery diagnosis")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Staging diagnostic authorization refused: " + type(error).__name__)
        raise SystemExit(1)
