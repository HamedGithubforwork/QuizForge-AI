"""Loopback model gateway with persistent request and USD cost ceilings.

Every upstream attempt consumes a committed PostgreSQL reservation, even when
OpenAI fails. Missing/disabled/unavailable budget state prevents model calls.
USD reservations cover this gateway's model calls, not AWS or other API keys.
"""
from http.client import HTTPSConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import threading
from uuid import uuid4

import psycopg
from database import options as database_options
from generation_costs import MODEL, MAX_OUTPUT_TOKENS, PRICING_KEY, maximum_cost, accounted_cost

MAX_BODY_BYTES = 524288
MAX_RESPONSE_BYTES = 4 * 1024 * 1024


def bounded_request(raw):
    if not 0 < len(raw) <= MAX_BODY_BYTES:
        raise ValueError("Invalid request size")
    body = json.loads(raw)
    if not isinstance(body, dict) or set(body) - {"model", "input", "text", "max_output_tokens", "store"}:
        raise ValueError("Unsupported request fields")
    if body.get("model") != MODEL or not isinstance(body.get("input"), list) or not body["input"]:
        raise ValueError("Unexpected model or input")
    if any(not isinstance(m, dict) or set(m) != {"role", "content"}
           or m["role"] not in {"developer", "user"} or not isinstance(m["content"], str) for m in body["input"]):
        raise ValueError("Only bounded text input is allowed")
    cap = body.get("max_output_tokens", MAX_OUTPUT_TOKENS)
    if type(cap) is not int or cap < 1:
        raise ValueError("Invalid output bound")
    body["max_output_tokens"] = min(cap, MAX_OUTPUT_TOKENS)
    body["store"] = False
    body["service_tier"] = "default"  # Never inherit a more expensive project tier.
    return json.dumps(body).encode()


def connection_options(env):
    if env.get("PGUSER") != "quizforge_generation":
        raise ValueError("Unexpected generation budget database role")
    result = database_options(env)
    result.pop("row_factory")
    result.update(connect_timeout=5, options="-c statement_timeout=5000 -c lock_timeout=3000")
    return result


def reserve(options, attempt_id, cost):
    # The connection context commits before the external request begins.
    with psycopg.connect(**options) as conn:
        return conn.execute("SELECT billing.reserve_generation_cost(%s,%s,%s)",
                            (attempt_id, cost, PRICING_KEY)).fetchone()[0] is True


def settle(options, attempt_id, cost):
    with psycopg.connect(**options) as conn:
        return conn.execute("SELECT billing.settle_generation_cost(%s,%s)",
                            (attempt_id, cost)).fetchone()[0] is True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self.server.slots.acquire(blocking=False):
            self.reply(429, b'{"error":{"message":"Generation capacity reached"}}')
            return
        upstream = None
        try:
            self.connection.settimeout(10)
            if self.path != "/v1/responses" or self.headers.get("Authorization") != "Bearer production-budget-guard":
                self.reply(403, b'{"error":{"message":"Request refused"}}')
                return
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or self.headers.get("Transfer-Encoding"):
                raise ValueError("Ambiguous request size")
            size = int(lengths[0])
            if not 0 < size <= MAX_BODY_BYTES:
                raise ValueError("Invalid request size")
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise ValueError("Incomplete request")
            body = bounded_request(raw)
            output_limit = json.loads(body)["max_output_tokens"]
            attempt_id = uuid4()
            if not reserve(self.server.database, attempt_id, maximum_cost(output_limit)):
                self.reply(429, b'{"error":{"message":"Generation usage limit reached"}}')
                return
            upstream = HTTPSConnection("api.openai.com", timeout=100)
            upstream.request("POST", "/v1/responses", body=body, headers={
                "Authorization": "Bearer " + os.environ["OPENAI_API_KEY"], "Content-Type": "application/json"})
            response = upstream.getresponse()
            data = response.read(MAX_RESPONSE_BYTES + 1)
            if len(data) > MAX_RESPONSE_BYTES or 300 <= response.status < 400:
                raise ValueError("Unexpected upstream response")
            cost = accounted_cost(data, output_limit) if response.status == 200 else None
            if cost is not None:
                # Failure here keeps the committed maximum; retrying cannot refund twice.
                settle(self.server.database, attempt_id, cost)
            self.reply(response.status, data)
            print("Model attempt completed; status=" + str(response.status), flush=True)
        except (ValueError, UnicodeError):
            self.reply(400, b'{"error":{"message":"Invalid generation request"}}')
        except Exception:
            self.reply(503, b'{"error":{"message":"Generation temporarily unavailable"}}')
        finally:
            if upstream:
                upstream.close()
            self.server.slots.release()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8002), Handler)
    server.database = connection_options(os.environ)
    server.slots = threading.BoundedSemaphore(8)
    server.serve_forever()
