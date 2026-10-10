from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
import unittest
from uuid import uuid4

from redis import Redis
from generation_guard import bounded_request, MAX_OUTPUT_TOKENS, MAX_BODY_BYTES, RESERVE


class RequestBoundaries(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.deadline = (self.now + timedelta(hours=1)).isoformat()
        self.body = {"model":"gpt-5.6-luna", "input":[{"role":"user", "content":"Synthetic notes"}],
                     "text":{"format":{"type":"json_schema", "name":"quiz", "schema":{}}}}

    def bounded(self, body):
        return json.loads(bounded_request(json.dumps(body).encode(), self.deadline, self.now))

    def test_forces_output_cap_and_no_retention(self):
        result = self.bounded(self.body | {"max_output_tokens":1000000, "store":True})
        self.assertEqual(result["max_output_tokens"], MAX_OUTPUT_TOKENS)
        self.assertIs(result["store"], False)
        self.assertEqual(result["text"], self.body["text"])

    def test_refuses_tools_streaming_other_models_and_external_inputs(self):
        for change in ({"tools":[]}, {"stream":True}, {"model":"other-model"}, {"previous_response_id":"old"},
                       {"input":[{"role":"user", "content":[{"type":"input_image", "image_url":"https://example.invalid"}]}]},
                       {"input":[{"role":"assistant", "content":"old"}]}, {"input":[]}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.bounded(self.body | change)

    def test_expiry_extended_lease_and_oversize_fail_closed(self):
        for hours in (-1, 3):
            with self.assertRaises(ValueError):
                bounded_request(json.dumps(self.body).encode(), (self.now + timedelta(hours=hours)).isoformat(), self.now)
        with self.assertRaises(ValueError):
            self.bounded(self.body | {"input":[{"role":"user", "content":"x" * MAX_BODY_BYTES}]})


@unittest.skipUnless(os.environ.get("INTEGRATED_TEST_REDIS_URL"), "CI supplies disposable Valkey")
class DistributedBudget(unittest.TestCase):
    def test_concurrent_connections_cannot_exceed_cap_or_recreate_missing_budget(self):
        # Exercise actual Lua in Valkey, including task replacement and lost state.
        clients = [Redis.from_url(os.environ["INTEGRATED_TEST_REDIS_URL"]) for _ in range(16)]
        prefix = "integration-test:" + uuid4().hex
        remaining, calls = prefix + ":remaining", prefix + ":calls"
        try:
            self.assertEqual(clients[0].eval(RESERVE, 2, remaining, calls), 0)
            clients[0].set(remaining, 2)
            with ThreadPoolExecutor(max_workers=16) as workers:
                results = list(workers.map(lambda c:c.eval(RESERVE, 2, remaining, calls), clients))
            self.assertEqual(sum(results), 2)
            self.assertEqual(clients[0].get(calls), b"2")
            self.assertEqual(clients[0].get(remaining), b"0")
            self.assertEqual(clients[0].ttl(remaining), -1)
            with Redis.from_url(os.environ["INTEGRATED_TEST_REDIS_URL"]) as replacement:
                self.assertEqual(replacement.eval(RESERVE, 2, remaining, calls), 0)
                replacement.delete(remaining)
                self.assertEqual(replacement.eval(RESERVE, 2, remaining, calls), 0)
                self.assertEqual(replacement.get(calls), b"2")
        finally:
            clients[0].delete(remaining, calls)
            for client in clients:
                client.close()
