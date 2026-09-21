"""No-paid-call checks for the canary's application/SDK retry boundary."""
import asyncio
from http.server import ThreadingHTTPServer
import json
import threading
import unittest
from unittest.mock import patch

import ai_canary
import generation_guard as guard


class SingleAttempt(unittest.TestCase):
    def exercise(self, valid):
        raw = json.loads(ai_canary.synthetic_response())
        if not valid:
            raw["output"][0]["content"][0]["text"] = json.dumps({"title": "Invalid", "questions": []})
        response = json.dumps(raw).encode()

        class Provider:
            status = 200
            def __init__(self, *args, **kwargs): pass
            def request(inner, method, path, *, body, headers):
                payload = json.loads(body)
                self.assertEqual(payload["text"]["format"]["type"], "json_schema")
                self.assertEqual(payload["service_tier"], "default")
                self.assertEqual(payload["max_output_tokens"], 8192)
                self.assertIs(payload["store"], False)
            def getresponse(self): return self
            def read(self, limit): return response[:limit]
            def close(self): pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), guard.Handler)
        server.database = {}
        server.slots = threading.BoundedSemaphore(1)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        record = {"sdk_requests": 0}
        try:
            with patch.dict("os.environ", {"OPENAI_API_KEY": "synthetic-not-sent"}), \
                 patch.object(guard, "HTTPSConnection", Provider), \
                 patch.object(guard, "reserve", return_value=True) as reserve, \
                 patch.object(guard, "settle", return_value=True) as settle:
                if valid:
                    asyncio.run(ai_canary.generate_once(server.server_port, record))
                    self.assertTrue(record["application_validation_passed"])
                    self.assertEqual(len(record["quiz"]["questions"]), 5)
                else:
                    with self.assertRaisesRegex(RuntimeError, "retry suppressed"):
                        asyncio.run(ai_canary.generate_once(server.server_port, record))
                self.assertEqual(record["sdk_requests"], 1)
                self.assertEqual(reserve.call_count, 1)
                self.assertEqual(settle.call_count, 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_exact_application_parses_and_expands_compact_quiz(self):
        self.exercise(True)

    def test_invalid_quiz_cannot_trigger_second_paid_attempt(self):
        self.exercise(False)


if __name__ == "__main__":
    unittest.main()
