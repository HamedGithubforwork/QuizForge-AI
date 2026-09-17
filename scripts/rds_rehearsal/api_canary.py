"""Real authenticated HTTP requests to the reviewed API container, no DB/AWS credentials."""
import json
import os
import sys
import time
import traceback
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import UUID

BASE = "http://127.0.0.1:8000"
CANARY_USER = str(UUID(int=3))


def request(method, path, token=None, payload=None, headers=None):
    headers = dict(headers or {})
    if token: headers["Authorization"] = "Bearer " + token
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    message = Request(BASE + path, method=method, data=data, headers=headers)
    try:
        with urlopen(message, timeout=20) as response:
            body = response.read()
            headers = {key.lower(): value for key, value in response.headers.items()}
            content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
            # CORS preflight is text/plain ("OK"); history responses remain JSON.
            parsed = None if not body else json.loads(body) if content_type == "application/json" else body.decode()
            return response.status, parsed, headers
    except HTTPError as error:
        # A failed response may contain private values; retain only its status.
        return error.code, None, dict(error.headers)


def entry(title="RDS API validation"):
    return {"quiz_title": title, "source_filename": "rds-api-validation.pdf", "document_sha256": "a" * 64,
            "difficulty": "easy", "question_type": "multiple_choice", "question_count": 5,
            "score": 4, "percentage": 80, "quiz_data": {"questions": []}, "selected_answers": {"0": 1}}


def refresh_cognito(session):
    import boto3
    from botocore import UNSIGNED
    from botocore.config import Config
    # User-token operations only: no task IAM credentials, no EC2 metadata lookup.
    client = boto3.client("cognito-idp", region_name="ca-central-1",
                          config=Config(signature_version=UNSIGNED, connect_timeout=10, read_timeout=20))
    for user in (session, session["unmapped"], session["unverified"]):
        fresh = client.initiate_auth(ClientId=session["client_id"], AuthFlow="REFRESH_TOKEN_AUTH",
                                     AuthParameters={"REFRESH_TOKEN": user["refresh_token"]})["AuthenticationResult"]
        user["access_token"], user["id_token"] = fresh["AccessToken"], fresh["IdToken"]
    return client


def main():
    assert not any(os.getenv(key) for key in ("PGUSER", "PGPASSWORD", "HISTORY_DB_PASSWORD",
                                             "AWS_ACCESS_KEY_ID", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"))
    session = json.loads(os.environ["CANARY_SESSION"])
    cognito = refresh_cognito(session) if session.get("provider") == "cognito" else None
    token = session["access_token"]
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            if request("GET", "/api/health")[0] == 200: break
        except URLError:
            pass
        time.sleep(2)
    else:
        raise AssertionError("API did not become healthy")
    for method, path in [("GET", "/api/quiz-history"), ("POST", "/api/quiz-history"),
                         ("GET", "/api/quiz-history/document?source_filename=rds-api-validation.pdf"),
                         ("DELETE", "/api/quiz-history/" + str(UUID(int=100)))]:
        for rejected in (None, "invalid-token"):
            assert request(method, path, rejected, entry() if method == "POST" else None)[0] == 401
    print("PASS: real API rejects missing and invalid bearer tokens on every history route")
    if cognito:
        assert request("GET", "/api/quiz-history", session["id_token"])[0] == 401
        assert request("GET", "/api/quiz-history", session["unmapped"]["access_token"])[0] == 403
        assert request("GET", "/api/quiz-history", session["unverified"]["access_token"])[0] == 403
        print("PASS: real Cognito ID token, unmapped same-email account and unverified-email account cannot access history")
    status, initial, _ = request("GET", "/api/quiz-history", token)
    assert status == 200 and initial["totalCount"] == 0 and initial["items"] == []
    assert request("POST", "/api/quiz-history", token, {**entry(), "user_id": str(UUID(int=1))})[0] == 422
    for index in range(3):
        assert request("POST", "/api/quiz-history", token, entry(f"RDS API validation {index}"))[0] == 201
    status, page, _ = request("GET", "/api/quiz-history?limit=2", token)
    assert status == 200 and page["totalCount"] == 3 and page["hasMore"]
    cursor = page["nextCursor"]
    status, second, _ = request("GET", "/api/quiz-history?" + urlencode({
        "limit": 2, "cursor_created_at": cursor["createdAt"], "cursor_id": cursor["id"]}), token)
    assert status == 200 and second["totalCount"] is None and not second["hasMore"]
    rows = page["items"] + second["items"]
    assert len(rows) == 3 and len({r["id"] for r in rows}) == 3
    assert all(r["user_id"] == CANARY_USER for r in rows)
    status, documents, _ = request("GET", "/api/quiz-history/document?" + urlencode({
        "source_filename": "rds-api-validation.pdf", "document_sha256": "a" * 64}), token)
    assert status == 200 and {r["id"] for r in documents} == {r["id"] for r in rows}
    assert request("DELETE", "/api/quiz-history/" + str(UUID(int=100)), token)[0] == 204
    print("PASS: real provider authentication, internal identity mapping, create/list/cursor/document queries and foreign deletion checks")
    preflight = {"Origin": "https://rds-rehearsal.invalid", "Access-Control-Request-Method": "DELETE",
                 "Access-Control-Request-Headers": "authorization"}
    status, body, headers = request("OPTIONS", "/api/quiz-history/" + rows[0]["id"], headers=preflight)
    assert status == 200 and body == "OK"
    assert headers["access-control-allow-origin"] == preflight["Origin"]
    assert "DELETE" in headers["access-control-allow-methods"].split(", ")
    assert request("OPTIONS", "/api/quiz-history/" + rows[0]["id"],
                   headers={**preflight, "Origin": "https://untrusted.invalid"})[0] == 400
    for row in rows:
        assert request("DELETE", "/api/quiz-history/" + row["id"], token)[0] == 204
    status, final, _ = request("GET", "/api/quiz-history", token)
    assert status == 200 and final["items"] == [] and final["totalCount"] == 0
    print("PASS: trusted CORS preflight, untrusted-origin rejection and own-row deletion; no OpenAI calls")
    if cognito:
        cognito.revoke_token(ClientId=session["client_id"], Token=session["refresh_token"])
        assert request("GET", "/api/quiz-history", token)[0] == 401
        print("PASS: real revoked Cognito access token rejected by FastAPI despite a previously cached signing key")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        line = traceback.extract_tb(error.__traceback__)[-1].lineno
        print(f"ERROR: private RDS API canary failed ({type(error).__name__}, line {line})")
        sys.exit(1)
