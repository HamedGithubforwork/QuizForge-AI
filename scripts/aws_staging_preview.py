"""Resolve only a same-repository PR commit that passed the existing CI gate.

Runs before AWS authentication. Never executes PR-controlled scripts on the
credentialed deployment runner; the separate build runner has no AWS identity.
"""
import json
import os
import re
from urllib.request import Request, urlopen

REPOSITORY = "HamedGithubforwork/QuizForge-AI"
BASE_BRANCH = "application/production"
BACKEND_REQUIRED = {
    "Required PR gate", "Backend tests", "PostgreSQL history API security",
    "Architecture boundaries", "Build backend image",
}
FRONTEND_REQUIRED = {
    "Required PR gate", "Frontend checks", "Playwright E2E",
    "Architecture boundaries", "cognito-browser",
}


def resolve(pr, checks, required):
    if (pr.get("state") != "open" or pr.get("base", {}).get("ref") != BASE_BRANCH
            or pr.get("head", {}).get("repo", {}).get("full_name") != REPOSITORY):
        raise ValueError("Staging requires open same-repository PRs targeting application/production.")
    sha = pr["head"]["sha"]
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Invalid PR commit.")
    latest = {}
    for check in checks:
        if check.get("head_sha") != sha or check.get("app", {}).get("slug") != "github-actions":
            continue
        name = check["name"]
        if name not in latest or check["id"] > latest[name]["id"]:
            latest[name] = check
    for name in required:
        check = latest.get(name, {})
        if check.get("status") != "completed" or check.get("conclusion") != "success":
            raise ValueError(f"Staging requires a successful {name} on the exact PR commit.")
    return sha


def github(path):
    request = Request(f"https://api.github.com/repos/{REPOSITORY}/{path}", headers={
        "Authorization": "Bearer " + os.environ["GH_TOKEN"],
        "Accept": "application/vnd.github+json",
    })
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def checked_pr(number, required):
    if not re.fullmatch(r"[1-9][0-9]*", number):
        raise ValueError("PR numbers must be positive integers.")
    pr = github(f"pulls/{number}")
    checks = []
    for page in range(1, 11):
        batch = github(f"commits/{pr['head']['sha']}/check-runs?per_page=100&page={page}")["check_runs"]
        checks.extend(batch)
        if len(batch) < 100:
            break
    return resolve(pr, checks, required)


if __name__ == "__main__":
    backend_sha = checked_pr(os.environ["PREVIEW_BACKEND_PR"], BACKEND_REQUIRED)
    frontend_sha = checked_pr(os.environ["PREVIEW_FRONTEND_PR"], FRONTEND_REQUIRED)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"backend_sha={backend_sha}\n")
        output.write(f"frontend_sha={frontend_sha}\n")
    print("Validated current backend and frontend PR commits; required CI passed.")
