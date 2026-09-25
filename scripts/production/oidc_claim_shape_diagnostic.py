"""Report only boolean GitHub OIDC claim-shape checks; never print the token or raw claims."""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

RESULT = Path("oidc-claim-shape-results/summary.json")
OLD_SUBJECT = "repo:HamedGithubforwork/QuizForge-AI:ref:refs/heads/main"
IMMUTABLE_SUBJECT = "repo:HamedGithubforwork@148009407/QuizForge-AI@1307099196:ref:refs/heads/main"
EXPECTED = {
    "repository": "HamedGithubforwork/QuizForge-AI",
    "repository_id": "1307099196",
    "repository_owner": "HamedGithubforwork",
    "repository_owner_id": "148009407",
    "ref": "refs/heads/main",
    "event_name": "push",
    "workflow_ref": "HamedGithubforwork/QuizForge-AI/.github/workflows/oidc-claim-shape-diagnostic.yml@refs/heads/main",
    "run_attempt": "1",
}


def decode_payload(token: str) -> dict:
    if token.count(".") != 2 or len(token) > 10000:
        raise ValueError("Unexpected OIDC token envelope")
    payload = token.split(".")[1]
    payload += "=" * ((4 - len(payload) % 4) % 4)
    value = json.loads(base64.urlsafe_b64decode(payload.encode()))
    if not isinstance(value, dict):
        raise ValueError("Unexpected OIDC claims")
    return value


def main() -> int:
    base = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
    separator = "&" if "?" in base else "?"
    audience = os.environ["OIDC_AUDIENCE"]
    req = Request(
        base + separator + "audience=" + quote(audience, safe=""),
        headers={"Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]},
    )
    with urlopen(req, timeout=15) as response:
        token = json.load(response).get("value", "")
    claims = decode_payload(token)

    subject = str(claims.get("sub", ""))
    if subject == OLD_SUBJECT:
        subject_mode = "legacy"
    elif subject == IMMUTABLE_SUBJECT:
        subject_mode = "immutable"
    else:
        subject_mode = "unexpected"

    checks = {
        name + "_ok": str(claims.get(name, "")) == expected
        for name, expected in EXPECTED.items()
    }
    report = {
        "schema": 1,
        "subject_mode": subject_mode,
        **checks,
        "audience_ok": claims.get("aud") == audience,
        "issuer_ok": claims.get("iss") == "https://token.actions.githubusercontent.com",
        "token_or_raw_claims_published": False,
    }
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print("OIDC subject mode=" + subject_mode)
    print("OIDC allowlisted checks=" + ("passed" if all(v is True for k, v in report.items() if k.endswith("_ok")) else "failed"))
    return 0 if subject_mode in {"legacy", "immutable"} and all(
        value is True for key, value in report.items() if key.endswith("_ok")
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
