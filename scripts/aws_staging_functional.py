"""Opt-in validation of disposable AWS staging; never targets production.

One quiz generation and one semantic answer review use OpenAI. Other requests
exercise caches, validation, and rate limits without generating more content.
Credentials stay in runner memory and are never passed in ECS task overrides.
"""

import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
import uuid


class ValidationError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise ValidationError(message)


def validate_staging_url(url):
    parsed = urlsplit(url)
    require(
        parsed.scheme == "http"
        and re.fullmatch(
            r"quizforge-staging-api-[0-9]+\.ca-central-1\.elb\.amazonaws\.com",
            parsed.hostname or "",
        )
        and not parsed.username
        and not parsed.password
        and parsed.port is None
        and parsed.path in ("", "/")
        and not parsed.query
        and not parsed.fragment,
        "Functional validation requires the ca-central-1 staging ALB URL.",
    )
    return url.rstrip("/")


def request(url, *, token=None, body=None, content_type=None, expected=200):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if content_type:
        headers["Content-Type"] = content_type
    req = Request(url, data=body, headers=headers)
    try:
        response = urlopen(req, timeout=150)
    except HTTPError as error:
        response = error
    # Never include response bodies, headers, or credentials in diagnostics.
    with response:
        status = response.status
        payload = response.read()
        response_headers = response.headers
    require(status == expected, f"{urlsplit(url).path}: expected {expected}, got {status}")
    return json.loads(payload), response_headers


def make_pdf(run_id):
    lines = [
        "QuizForge AWS staging validation: " + run_id,
        "Water moves through the water cycle in several stages.",
        "Evaporation converts liquid water into water vapor using heat.",
        "Condensation converts water vapor into liquid droplets as it cools.",
        "Precipitation returns water from clouds to Earth as rain or snow.",
        "Collection stores water in lakes, rivers, and oceans.",
        "Infiltration moves water into soil and replenishes groundwater.",
        "Transpiration releases water vapor from plant leaves.",
        "The Sun supplies the energy that drives evaporation.",
        "Gravity moves precipitation and surface runoff toward lower ground.",
    ]
    stream = b"BT /F1 11 Tf 45 760 Td 17 TL\n"
    for line in lines:
        escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream += f"({escaped}) Tj T*\n".encode("ascii")
    stream += b"ET\n"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"endstream",
    ]
    pdf = b"%PDF-1.4\n"
    offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf += f"{number} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(pdf)
    pdf += b"xref\n0 6\n0000000000 65535 f \n"
    pdf += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
    pdf += f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return pdf


def multipart_pdf(pdf):
    boundary = "quizforge-" + uuid.uuid4().hex
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="aws-staging.pdf"\r\n'
        'Content-Type: application/pdf\r\n\r\n'
    ).encode() + pdf + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def aws(*args):
    result = subprocess.run(
        ["aws", *args, "--output", "json"], capture_output=True, text=True,
        timeout=90, check=False,
    )
    require(result.returncode == 0, f"AWS {args[0]} {args[1]} failed; inspect the workflow and AWS permissions.")
    return json.loads(result.stdout or "{}")


def terraform_output():
    result = subprocess.run(
        ["terraform", "output", "-json"], capture_output=True, text=True,
        timeout=30, check=False,
    )
    require(result.returncode == 0, "Could not read staging Terraform outputs.")
    return {key: value["value"] for key, value in json.loads(result.stdout).items()}


def login():
    supabase_url = aws("ssm", "get-parameter", "--name", "/quizforge/prod/SUPABASE_URL")["Parameter"]["Value"]
    supabase_key = aws("ssm", "get-parameter", "--name", "/quizforge/prod/SUPABASE_PUBLISHABLE_KEY", "--with-decryption")["Parameter"]["Value"]
    require(urlsplit(supabase_url).scheme == "https", "Supabase login must use HTTPS.")
    payload = json.dumps({
        "email": os.environ["QUIZFORGE_CANARY_EMAIL"],
        "password": os.environ["QUIZFORGE_CANARY_PASSWORD"],
    }).encode()
    req = Request(
        supabase_url.rstrip("/") + "/auth/v1/token?grant_type=password",
        data=payload, headers={"apikey": supabase_key, "Content-Type": "application/json"},
    )
    with urlopen(req, timeout=20) as response:
        auth = json.load(response)
    require(bool(auth.get("access_token")), "Canary login did not return a token.")
    return auth["access_token"], auth["user"]["id"]


def run_private_probe(outputs, context):
    source = Path(__file__).with_name("aws_staging_valkey_probe.py").read_bytes()
    compressed = base64.b64encode(gzip.compress(source)).decode()
    code = "import gzip,base64; exec(compile(gzip.decompress(base64.b64decode(" + repr(compressed) + ")), '<staging-probe>', 'exec'))"
    overrides = {"containerOverrides": [{
        "name": "api", "command": ["python", "-c", code],
        "environment": [{"name": "STAGING_PROBE_CONTEXT", "value": json.dumps(context)}],
    }]}
    encoded = json.dumps(overrides)
    require(len(encoded) < 8192, "ECS probe override exceeds the AWS size limit.")
    response = aws(
        "ecs", "run-task", "--cluster", outputs["ecs_cluster_name"],
        "--launch-type", "FARGATE", "--task-definition", outputs["ecs_task_definition_arn"],
        "--started-by", "quizforge-functional-validation", "--count", "1",
        "--network-configuration", json.dumps({"awsvpcConfiguration": {
            "subnets": outputs["public_subnet_ids"],
            "securityGroups": [outputs["app_security_group_id"]], "assignPublicIp": "ENABLED",
        }}), "--overrides", encoded,
    )
    tasks = response.get("tasks", [])
    require(len(tasks) == 1 and not response.get("failures"), "ECS did not start the private Valkey probe.")
    task_arn = tasks[0]["taskArn"]
    try:
        deadline = time.monotonic() + 420
        while time.monotonic() < deadline:
            description = aws("ecs", "describe-tasks", "--cluster", outputs["ecs_cluster_name"], "--tasks", task_arn)
            task = description["tasks"][0]
            if task["lastStatus"] == "STOPPED":
                containers = task.get("containers", [])
                require(len(containers) == 1 and containers[0].get("exitCode") == 0,
                        "Private Valkey functional probe failed; inspect its CloudWatch stream.")
                print("PASS: private Valkey caches, metrics, distributed limits, and generation locks")
                return
            time.sleep(10)
        raise ValidationError("Private Valkey probe exceeded seven minutes.")
    finally:
        # Stop is idempotent for an already stopped task and covers test failures.
        aws("ecs", "stop-task", "--cluster", outputs["ecs_cluster_name"], "--task", task_arn,
            "--reason", "Functional validation finished")


def main():
    outputs = terraform_output()
    url = validate_staging_url(outputs["api_http_url"])
    token, user_id = login()
    run_id = uuid.uuid4().hex
    missing = "/api/documents/" + "0" * 64 + "/pages/1"
    request(url + "/api/health")
    request(url + missing, expected=401)
    request(url + missing, token="invalid-staging-token", expected=401)
    request(url + missing, token=token, expected=410)
    print("PASS: health, missing/invalid token rejection, authenticated protected route")

    pdf = make_pdf(run_id)
    pdf_sha = hashlib.sha256(pdf).hexdigest()
    body, content_type = multipart_pdf(pdf)
    upload, _ = request(url + "/api/documents/upload", token=token, body=body, content_type=content_type)
    require(upload.get("pdf_sha256") == pdf_sha and upload.get("page_count") == 1
            and upload.get("character_count", 0) > 400 and not upload.get("scanned_likely"),
            "Small PDF processing returned unexpected document metadata.")
    repeated_upload, _ = request(url + "/api/documents/upload", token=token, body=body, content_type=content_type)
    require(upload == repeated_upload, "Repeated PDF upload changed its response.")
    source_path = f"/api/documents/{pdf_sha}/pages/1"
    source, _ = request(url + source_path, token=token)
    source_again, _ = request(url + source_path, token=token)
    require(source == source_again and "Evaporation" in source.get("text", ""), "Source-page retrieval failed.")
    request(url + f"/api/documents/{pdf_sha}/pages/2", token=token, expected=404)
    print("PASS: small PDF upload, processing, repeated upload, source pages and missing-page rejection")

    generation_body = urlencode({"document_sha256": pdf_sha, "question_count": 5,
                                 "difficulty": "easy", "question_type": "multiple_choice"}).encode()
    quiz, _ = request(url + "/api/quizzes/generate", token=token, body=generation_body,
                      content_type="application/x-www-form-urlencoded")
    require(len(quiz.get("questions", [])) == 5, "Quiz must contain five questions.")
    for question in quiz["questions"]:
        require(question.get("question_type") == "multiple_choice"
                and len(question.get("choices", [])) == 4
                and question.get("correct_index") in range(4)
                and question.get("source_pages") == [1], "Generated quiz contract or source grounding failed.")
    cached_quiz, _ = request(url + "/api/quizzes/generate", token=token, body=generation_body,
                             content_type="application/x-www-form-urlencoded")
    require(quiz == cached_quiz, "Repeated generation did not return the same cached quiz.")
    print("PASS: real five-question generation and repeat quiz-cache request")

    review = {"cases": [{"question_index": 0, "question": "What drives evaporation in the water cycle?",
                         "correct_answer": "Heat from the Sun", "accepted_answers": [],
                         "answer_groups": [["solar heat", "heat from the Sun"]], "required_group_count": 1,
                         "student_answer": "Thermal energy supplied by sunlight", "explanation": "The Sun supplies heat."}]}
    answer, _ = request(url + "/api/answers/review", token=token, body=json.dumps(review).encode(),
                         content_type="application/json")
    decisions = answer.get("decisions", [])
    require(len(decisions) == 1 and decisions[0].get("question_index") == 0
            and decisions[0].get("verdict") == "correct" and decisions[0].get("confidence", 0) >= 0.8,
            "Semantic answer review did not recognize the clear paraphrase.")
    request(url + "/api/answers/review", token=token, body=b'{"cases":[]}',
            content_type="application/json", expected=422)
    print("PASS: one real semantic answer review and invalid-payload rejection")

    # Invalid question_count fails before OpenAI; use it to fill the real limiter.
    for _ in range(8):
        request(url + "/api/quizzes/generate", token=token, body=b"question_count=1",
                content_type="application/x-www-form-urlencoded", expected=400)
    _, headers = request(url + "/api/quizzes/generate", token=token, body=b"question_count=1",
                         content_type="application/x-www-form-urlencoded", expected=429)
    require(1 <= int(headers.get("Retry-After", "0")) <= 600, "Rate limit must provide bounded Retry-After.")
    print("PASS: API rate limit and Retry-After, with no extra quiz generation")
    run_private_probe(outputs, {"user_id": user_id, "pdf_sha256": pdf_sha, "run_id": run_id,
                               "quiz_digest": hashlib.sha256(json.dumps(quiz, sort_keys=True).encode()).hexdigest()})
    print("Full AWS staging functional validation passed. Stop staging now.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Third-party exception text can contain URLs or credentials.
        print(f"::error::{error if isinstance(error, ValidationError) else type(error).__name__}")
        sys.exit(1)
