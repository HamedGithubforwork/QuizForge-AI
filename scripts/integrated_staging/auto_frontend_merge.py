"""Authorize exactly one reviewed GitHub merge to publish frontend PR #538 to staging.

No AWS credentials; this module is used before any cloud access. The push
must be the merge of the named operations PR, containing exactly the authorized
five-file change set, including one newly added request marker.
"""
import json
import os
from pathlib import Path
import re
import subprocess

REPOSITORY = "HamedGithubforwork/QuizForge-AI"
TRIGGER_BRANCH = "ops/staging-signup-resume-checklist-v2"
MARKER = ".github/staging-update-requests/frontend-signup-resume-checklist-v2.json"
FRONTEND_PR = "538"
FRONTEND_SHA = "af9393ac74301f1e298b11f83a32a620bd7fdac3"
REQUEST = {
    "operation": "frontend",
    "frontend_pr": 538,
    "frontend_sha": FRONTEND_SHA,
    "environment": "quizforge-integrated-staging",
    "mode": "one-time-reviewed-main-merge",
}
CHANGES = {
    f"A\t{MARKER}",
    "M\t.github/workflows/aws-integrated-staging-frontend-update.yml",
    "M\tscripts/integrated_staging/auto_frontend_merge.py",
    "M\tscripts/integrated_staging/test_auto_frontend_merge.py",
    "M\te2e/staging-live-auth-smoke.mjs",
}
SHA = re.compile(r"[0-9a-f]{40}")


def authorize(event, changes, prs, request):
    if event.get("ref") != "refs/heads/main" or event.get("repository", {}).get("full_name") != REPOSITORY:
        raise ValueError("Unapproved staging repository or branch")
    before, after = event.get("before"), event.get("after")
    if not all(isinstance(s, str) and SHA.fullmatch(s) and s != "0" * 40
               for s in [before, after]) or before == after:
        raise ValueError("Unexpected main push boundary")
    if set(changes) != CHANGES or len(changes) != len(CHANGES):
        raise ValueError("One-time merge changed unapproved files")
    if request != REQUEST:
        raise ValueError("Unapproved staging request contents")
    if not isinstance(prs, list) or not any(
        isinstance(pr, dict) and pr.get("merged_at")
        and pr.get("merge_commit_sha") == after
        and pr.get("base", {}).get("ref") == "main"
        and pr.get("head", {}).get("ref") == TRIGGER_BRANCH
        and pr.get("head", {}).get("repo", {}).get("full_name") == REPOSITORY
        for pr in prs
    ):
        raise ValueError("Main push was not the approved staging update merge")
    return True


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def main():
    path = os.environ["GITHUB_OUTPUT"]
    if os.environ.get("GITHUB_EVENT_NAME") != "push":
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("approved=false\n")
        return
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    if (os.environ.get("GITHUB_REPOSITORY") != REPOSITORY or
            os.environ.get("GITHUB_SHA") != event.get("after")):
        raise ValueError("Unexpected GitHub push identity")
    changed = run("git", "diff", "--name-status", event["before"], event["after"]).splitlines()
    if not any(line.split("\t", 1)[-1] == MARKER for line in changed):
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("approved=false\n")
        print("PASS: unrelated push does not request frontend staging publication")
        return
    prs = json.loads(run("gh", "api", f"repos/{REPOSITORY}/commits/{event['after']}/pulls"))
    request = json.loads(Path(MARKER).read_text(encoding="utf-8"))
    authorize(event, changed, prs, request)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write("approved=true\n")
    print("PASS: exactly one reviewed staging-only frontend update authorized")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Staging frontend authorization refused: " + type(error).__name__)
        raise SystemExit(1)
