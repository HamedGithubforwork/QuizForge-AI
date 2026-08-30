#!/usr/bin/env python3
"""Read-only smoke test for the deployed QuizForge production stack.

The checks intentionally avoid authentication, database writes, PDF uploads,
quiz generation, Redis mutations, and OpenAI calls. They verify that the
public Vercel frontend and Render API are reachable and still satisfy the
production wiring/security contracts that a browser depends on.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass
from typing import Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

FRONTEND_URL = os.getenv(
    "QUIZFORGE_FRONTEND_URL",
    "https://quiz-forge-ai-nine.vercel.app",
).rstrip("/")
BACKEND_URL = os.getenv(
    "QUIZFORGE_BACKEND_URL",
    "https://quizforge-ai-api.onrender.com",
).rstrip("/")
USER_AGENT = "QuizForge-deployment-smoke/1.0"


class SmokeFailure(RuntimeError):
    """Raised when a production smoke-test contract is not satisfied."""


@dataclass(frozen=True)
class Response:
    status: int
    headers: Mapping[str, str]
    body: bytes

    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


def request(
    url: str,
    *,
    method: str = "GET",
    headers: Mapping[str, str] | None = None,
    timeout: float = 20.0,
) -> Response:
    request_headers = {"User-Agent": USER_AGENT}
    if headers:
        request_headers.update(headers)

    req = Request(url, method=method, headers=request_headers)
    try:
        with urlopen(req, timeout=timeout) as response:
            return Response(
                status=response.status,
                headers={key.lower(): value for key, value in response.headers.items()},
                body=response.read(),
            )
    except HTTPError as exc:
        return Response(
            status=exc.code,
            headers={key.lower(): value for key, value in exc.headers.items()},
            body=exc.read(),
        )


def request_with_retries(
    url: str,
    *,
    expected_status: int,
    method: str = "GET",
    headers: Mapping[str, str] | None = None,
    attempts: int = 3,
    delay_seconds: float = 2.0,
    timeout: float = 20.0,
) -> Response:
    last_detail = "no response"

    for attempt in range(1, attempts + 1):
        try:
            response = request(
                url,
                method=method,
                headers=headers,
                timeout=timeout,
            )
            if response.status == expected_status:
                return response
            last_detail = f"HTTP {response.status}"
        except (URLError, TimeoutError, OSError) as exc:
            last_detail = f"{type(exc).__name__}: {exc}"

        if attempt < attempts:
            print(
                f"WAIT {url} ({last_detail}); retrying in {delay_seconds:g}s "
                f"[{attempt}/{attempts}]",
                flush=True,
            )
            time.sleep(delay_seconds)

    raise SmokeFailure(
        f"{method} {url} did not return HTTP {expected_status} "
        f"after {attempts} attempts ({last_detail})"
    )


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def expect_json(response: Response, expected: object, label: str) -> None:
    try:
        payload = json.loads(response.body)
    except json.JSONDecodeError as exc:
        raise SmokeFailure(f"{label} did not return valid JSON") from exc
    expect(payload == expected, f"{label} returned unexpected JSON: {payload!r}")


def pass_check(message: str) -> None:
    print(f"PASS {message}", flush=True)


def check_frontend() -> None:
    frontend = request_with_retries(
        f"{FRONTEND_URL}/",
        expected_status=200,
        attempts=3,
    )
    html = frontend.text()
    expect("QuizForge AI" in html, "frontend HTML is missing the QuizForge AI title")
    expect('id="root"' in html or "id='root'" in html, "frontend HTML is missing #root")
    pass_check("Vercel frontend shell is reachable")

    script_sources = re.findall(
        r"<script\b[^>]*\bsrc=[\"']([^\"']+)[\"'][^>]*>",
        html,
        flags=re.IGNORECASE,
    )
    bundle_path = next((source for source in script_sources if source.endswith(".js")), None)
    expect(bundle_path is not None, "frontend HTML does not reference a JavaScript bundle")

    bundle_url = urljoin(f"{FRONTEND_URL}/", bundle_path)
    bundle = request_with_retries(bundle_url, expected_status=200, attempts=3)
    expect(len(bundle.body) > 1_000, "frontend JavaScript bundle is unexpectedly small")

    backend_host = urlparse(BACKEND_URL).netloc.encode("utf-8")
    expect(
        backend_host in bundle.body,
        "deployed frontend bundle does not reference the configured production backend host",
    )
    pass_check("deployed frontend bundle is present and wired to the Render backend")


def check_backend() -> None:
    # Render services may need to wake from an idle/cold state, so health gets
    # a longer retry window than the other read-only checks.
    health = request_with_retries(
        f"{BACKEND_URL}/api/health",
        expected_status=200,
        attempts=12,
        delay_seconds=10,
        timeout=20,
    )
    expect_json(
        health,
        {"message": "Frontend connected to FastAPI!"},
        "backend health endpoint",
    )
    pass_check("Render FastAPI health contract is healthy")

    root = request_with_retries(
        f"{BACKEND_URL}/",
        expected_status=200,
        attempts=3,
    )
    expect_json(
        root,
        {"message": "QuizForge AI backend is running"},
        "backend root endpoint",
    )
    pass_check("Render FastAPI root contract is healthy")

    expect(
        health.headers.get("x-content-type-options", "").lower() == "nosniff",
        "backend is missing X-Content-Type-Options: nosniff",
    )
    expect(
        health.headers.get("referrer-policy", "").lower() == "no-referrer",
        "backend is missing Referrer-Policy: no-referrer",
    )
    permissions_policy = health.headers.get("permissions-policy", "").lower()
    for directive in ("camera=()", "microphone=()", "geolocation=()"):
        expect(
            directive in permissions_policy,
            f"backend Permissions-Policy is missing {directive}",
        )
    pass_check("backend security response headers are present")

    metrics = request_with_retries(
        f"{BACKEND_URL}/api/admin/metrics",
        expected_status=401,
        attempts=3,
    )
    pass_check("admin metrics remain closed to unauthenticated requests")


def check_cors() -> None:
    preflight = request_with_retries(
        f"{BACKEND_URL}/api/documents/upload",
        method="OPTIONS",
        expected_status=200,
        headers={
            "Origin": FRONTEND_URL,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
        attempts=3,
    )

    allow_origin = preflight.headers.get("access-control-allow-origin", "")
    expect(
        allow_origin == FRONTEND_URL,
        f"CORS preflight returned unexpected allowed origin: {allow_origin!r}",
    )
    allow_methods = preflight.headers.get("access-control-allow-methods", "").upper()
    expect("POST" in allow_methods, "CORS preflight does not allow POST")
    allow_headers = preflight.headers.get("access-control-allow-headers", "").lower()
    expect("authorization" in allow_headers, "CORS preflight does not allow Authorization")
    expect("content-type" in allow_headers, "CORS preflight does not allow Content-Type")
    pass_check("production frontend origin passes the backend CORS preflight")


def main() -> int:
    print(f"QuizForge production smoke: frontend={FRONTEND_URL} backend={BACKEND_URL}")
    try:
        check_frontend()
        check_backend()
        check_cors()
    except SmokeFailure as exc:
        print(f"FAIL {exc}", file=sys.stderr, flush=True)
        return 1

    print("PASS all read-only production deployment smoke checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
