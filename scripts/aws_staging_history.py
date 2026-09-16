"""Read-only history validation against the disposable AWS staging API.

The existing dedicated canary authenticates with Supabase. All history writes
are rejected by auth/schema validation before reaching its production database.
Real CRUD/RLS is tested separately in the isolated local-stack CI suite.
"""
import json
import sys
import uuid
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from aws_staging_functional import aws, login, require, terraform_output, validate_staging_url, ValidationError


def request(url, *, method="GET", token=None, payload=None, expected=200, headers=None):
    from urllib.error import HTTPError
    headers = dict(headers or {})
    if token:
        headers["Authorization"] = "Bearer " + token
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode()
    try:
        response = urlopen(Request(url, data=body, headers=headers, method=method), timeout=30)
    except HTTPError as error:
        response = error
    with response:
        require(response.status == expected, f"History {method}: expected {expected}, got {response.status}")
        data = response.read()
        response_headers = response.headers
    return (json.loads(data) if data and response_headers.get_content_type() == "application/json" else None), response_headers


def main():
    base = validate_staging_url(terraform_output()["api_http_url"])
    token, user_id = login()
    endpoint = base + "/api/quiz-history"
    entry = {"quiz_title": "Rejected staging input", "source_filename": "staging.pdf",
             "difficulty": "easy", "question_type": "multiple_choice", "question_count": 5,
             "score": 0, "percentage": 0, "quiz_data": {}, "selected_answers": {},
             "user_id": str(uuid.uuid4())}
    for invalid_token in (None, "invalid-staging-token"):
        for method, path, payload in (("GET", "", None), ("GET", "/document?source_filename=staging.pdf", None),
                                      ("POST", "", entry), ("DELETE", "/" + str(uuid.uuid4()), None)):
            request(endpoint + path, method=method, token=invalid_token, payload=payload, expected=401)
    print("PASS: all history routes reject missing and invalid bearer tokens")

    page, _ = request(endpoint + "?limit=2", token=token)
    require(isinstance(page.get("items"), list) and isinstance(page.get("totalCount"), int), "Invalid history page contract")
    require(len(page["items"]) <= 2 and all(row["user_id"] == user_id for row in page["items"]), "History owner isolation failed")
    require(page["hasMore"] == (page["totalCount"] > 2), "History count/pagination mismatch")
    if page["hasMore"]:
        cursor = page["nextCursor"]
        query = urlencode({"limit": 2, "cursor_created_at": cursor["createdAt"], "cursor_id": cursor["id"]})
        next_page, _ = request(endpoint + "?" + query, token=token)
        require(all(row["user_id"] == user_id for row in next_page["items"]), "Next page owner mismatch")
        require(not ({r["id"] for r in page["items"]} & {r["id"] for r in next_page["items"]}), "Cursor repeated a row")
    missing = "staging-history-" + uuid.uuid4().hex + ".pdf"
    rows, _ = request(endpoint + "/document?" + urlencode({"source_filename": missing}), token=token)
    require(rows == [], "Missing document history must be empty")
    request(endpoint, method="POST", token=token, payload=entry, expected=422)
    request(endpoint + "/not-a-uuid", method="DELETE", token=token, expected=422)
    request(endpoint + "?cursor_created_at=invalid&cursor_id=invalid", token=token, expected=422)
    print("PASS: authenticated history reads, owner checks, cursor contract, and rejected forged writes")

    origins = aws("ssm", "get-parameter", "--name", "/quizforge/prod/ALLOWED_ORIGINS", "--with-decryption")["Parameter"]["Value"]
    origin = origins.split(",")[0].strip()
    require(origin.startswith("https://") and origin != "*", "Expected explicit production CORS origin")
    _, headers = request(endpoint + "/" + str(uuid.uuid4()), method="OPTIONS", headers={
        "Origin": origin, "Access-Control-Request-Method": "DELETE", "Access-Control-Request-Headers": "authorization"})
    require(headers.get("Access-Control-Allow-Origin") == origin, "Trusted history CORS preflight failed")
    request(endpoint, method="OPTIONS", headers={"Origin": "https://untrusted.invalid",
            "Access-Control-Request-Method": "DELETE"}, expected=400)
    print("PASS: trusted-origin DELETE preflight and untrusted-origin rejection")
    print("AWS history validation passed without database writes or OpenAI requests.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"::error::{error if isinstance(error, ValidationError) else type(error).__name__}")
        sys.exit(1)
