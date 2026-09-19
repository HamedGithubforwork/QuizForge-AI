"""Disposable loopback-only OpenAI budget guard; never part of production.

The API has a placeholder key. Only this sidecar receives the real SSM key.
A non-expiring Valkey counter survives task replacement, and missing/unavailable
budget state fails closed. Every upstream attempt consumes a slot, even errors.
"""
from datetime import datetime, timezone
from http.client import HTTPSConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os

from redis import Redis

BUDGET_KEY = "integration:openai:remaining"
CALLS_KEY = "integration:openai:calls"
MAX_CALLS = 2
MAX_BODY_BYTES = 32768
MAX_OUTPUT_TOKENS = 4096
RESERVE = """
local remaining = tonumber(redis.call('GET', KEYS[1]))
if not remaining or remaining <= 0 then return 0 end
redis.call('DECR', KEYS[1])
redis.call('INCR', KEYS[2])
return 1
"""


def bounded_request(raw, deadline, now=None):
    now = now or datetime.now(timezone.utc)
    end = datetime.fromisoformat(deadline.replace("Z", "+00:00"))
    if end.tzinfo is None or not 0 < (end - now).total_seconds() <= 7300:
        raise ValueError("Expired staging lease")
    if not 0 < len(raw) <= MAX_BODY_BYTES:
        raise ValueError("Oversized request")
    body = json.loads(raw)
    if not isinstance(body, dict) or set(body) - {"model", "input", "text", "max_output_tokens", "store"}:
        raise ValueError("Unsupported request fields")
    if body.get("model") != "gpt-5.6-luna" or not isinstance(body.get("input"), list):
        raise ValueError("Unexpected model or input")
    if not body["input"] or any(not isinstance(m, dict) or set(m) != {"role", "content"}
                               or m["role"] not in {"developer", "user"} or not isinstance(m["content"], str)
                               for m in body["input"]):
        raise ValueError("Only bounded text input is allowed")
    body["max_output_tokens"] = MAX_OUTPUT_TOKENS
    body["store"] = False
    return json.dumps(body).encode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # No request bodies, credentials or upstream error text in logs.

    def reply(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        upstream = None
        try:
            self.connection.settimeout(110)
            if self.path != "/v1/responses" or self.headers.get("Authorization") != "Bearer staging-budget-guard":
                self.reply(403, b'{"error":{"message":"Staging request refused"}}')
                return
            size = int(self.headers.get("Content-Length", "0"))
            if self.headers.get("Transfer-Encoding") or not 0 < size <= MAX_BODY_BYTES:
                raise ValueError("Invalid request size")
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise ValueError("Incomplete request")
            body = bounded_request(raw, os.environ["STAGING_DEADLINE"])
            if self.server.cache.eval(RESERVE, 2, BUDGET_KEY, CALLS_KEY) != 1:
                self.reply(429, b'{"error":{"message":"Staging generation budget exhausted"}}')
                return
            # Fixed host/path, TLS certificate validation, no redirects or retries.
            upstream = HTTPSConnection("api.openai.com", timeout=100)
            upstream.request("POST", "/v1/responses", body=body, headers={
                "Authorization": "Bearer " + os.environ["OPENAI_API_KEY"],
                "Content-Type": "application/json",
            })
            response = upstream.getresponse()
            data = response.read(1024 * 1024 + 1)
            if len(data) > 1024 * 1024 or 300 <= response.status < 400:
                raise ValueError("Unexpected upstream response")
            self.reply(response.status, data)
            print("PASS: bounded staging model request completed; upstream status=" + str(response.status), flush=True)
        except ValueError:
            self.reply(400, b'{"error":{"message":"Invalid staging request"}}')
        except Exception:
            self.reply(503, b'{"error":{"message":"Staging guard unavailable"}}')
        finally:
            if upstream:
                upstream.close()


if __name__ == "__main__":
    assert os.environ["REDIS_URL"].startswith("rediss://")
    server = ThreadingHTTPServer(("127.0.0.1", 8002), Handler)
    server.cache = Redis.from_url(os.environ["REDIS_URL"], socket_connect_timeout=5, socket_timeout=5)
    server.serve_forever()
