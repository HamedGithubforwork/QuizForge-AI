"""Resolve only a same-repository PR commit that passed the existing CI gate.

Runs before AWS authentication. Never executes PR-controlled scripts on the
credentialed deployment runner; the separate build runner has no AWS identity.
"""
import json
import os
import re
from urllib.request import Request, urlopen

REPOSITORY = "HamedGithubforwork/QuizForge-AI"
REQUIRED = {"Required PR gate", "Backend tests", "Frontend checks", "Playwright E2E",
            "Browser + Supabase + FastAPI + Redis", "Build backend image"}


def resolve(pr, checks):
    if (pr.get("state") != "open" or pr.get("base", {}).get("ref") != "main"
            or pr.get("head", {}).get("repo", {}).get("full_name") != REPOSITORY):
        raise ValueError("Preview requires an open same-repository PR targeting main.")
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
    for name in REQUIRED:
        check = latest.get(name, {})
        if check.get("status") != "completed" or check.get("conclusion") != "success":
            raise ValueError(f"Preview requires a successful {name} on the exact PR commit.")
    return sha


def github(path):
    request = Request(f"https://api.github.com/repos/{REPOSITORY}/{path}", headers={
        "Authorization": "Bearer " + os.environ["GH_TOKEN"],
        "Accept": "application/vnd.github+json",
    })
    with urlopen(request, timeout=30) as response:
        return json.load(response)


if __name__ == "__main__":
    number = os.environ["PREVIEW_PR"]
    if not re.fullmatch(r"[1-9][0-9]*", number):
        raise SystemExit("Preview PR must be a positive integer.")
    pr = github(f"pulls/{number}")
    checks = []
    for page in range(1, 11):
        batch = github(f"commits/{pr['head']['sha']}/check-runs?per_page=100&page={page}")["check_runs"]
        checks.extend(batch)
        if len(batch) < 100:
            break
    sha = resolve(pr, checks)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"sha={sha}\n")
    print(f"Validated PR #{number} at {sha}; required CI passed.")
