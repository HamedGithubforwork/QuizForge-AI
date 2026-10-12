"""Authenticate one specific reviewed merge before a staging Cognito update.

Only the existing verified Terraform updater can change AWS. No AWS credentials
are present while this code checks the main-push event and merged PR.
"""
import json
import os
import re
import subprocess
from pathlib import Path

MARKER = ".github/staging-update-requests/auth-parity-pr-563.json"
REPOSITORY = "HamedGithubforwork/QuizForge-AI"
PR_NUMBER = 563
REQUEST = {
    "operation": "align_auth_parity",
    "pull_request": PR_NUMBER,
    "environment": "quizforge-integrated-staging",
    "mode": "one-time-merge-only",
}
SHA = re.compile(r"^[0-9a-f]{40}$")


def authorize(event, changed, prs, request):
    if event.get("ref") != "refs/heads/main":
        raise ValueError("Unexpected non-main staging trigger")
    if event.get("repository", {}).get("full_name") != REPOSITORY:
        raise ValueError("Unexpected staging repository")
    before, after = event.get("before"), event.get("after")
    if not all(isinstance(s, str) and SHA.fullmatch(s) and s != "0" * 40
               for s in (before, after)) or before == after:
        raise ValueError("Unexpected push commit boundary")
    if changed != [f"A\t{MARKER}"]:
        raise ValueError("Only a newly-added reviewed staging request is authorized")
    if request != REQUEST:
        raise ValueError("Staging operation or authorization file changed")
    if not isinstance(prs, list) or not any(
        isinstance(pr, dict)
        and pr.get("number") == PR_NUMBER
        and pr.get("merged_at")
        and pr.get("merge_commit_sha") == after
        and pr.get("base", {}).get("ref") == "main"
        and pr.get("head", {}).get("repo", {}).get("full_name") == REPOSITORY
        for pr in prs
    ):
        raise ValueError("The specified trusted pull request was not merged")
    return True


def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY or (
        os.environ.get("GITHUB_EVENT_NAME") != "push"
    ) or os.environ.get("GITHUB_SHA") != event.get("after"):
        raise ValueError("Unexpected GitHub event environment")
    changes = command("git", "diff", "--name-status", event["before"],
                      event["after"], "--", MARKER).splitlines()
    prs = json.loads(command(
        "gh", "api", f"repos/{REPOSITORY}/commits/{event['after']}/pulls"
    ))
    request = json.loads(Path(MARKER).read_text(encoding="utf-8"))
    authorize(event, changes, prs, request)
    print("PASS: PR #563 merged into main with its one-time staging authorization")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Never include provider responses, credentials or token-bearing CLI logs.
        print("Automatic staging authorization refused: " + type(exc).__name__)
        raise SystemExit(1)
