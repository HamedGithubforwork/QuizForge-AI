import io
import json
import unittest
from unittest.mock import patch

import api_canary


class ResponseTests(unittest.TestCase):
    def response(self, body, content_type, status=200):
        response = io.BytesIO(body)
        response.status = status
        response.headers = {"Content-Type": content_type, "Access-Control-Allow-Origin": "https://rds-rehearsal.invalid"}
        return response

    def test_plain_text_cors_preflight_preserves_status_body_and_headers(self):
        with patch.object(api_canary, "urlopen", return_value=self.response(b"OK", "text/plain; charset=utf-8")):
            status, body, headers = api_canary.request("OPTIONS", "/api/quiz-history")
        self.assertEqual((status, body), (200, "OK"))
        self.assertEqual(headers["access-control-allow-origin"], "https://rds-rehearsal.invalid")

    def test_history_response_still_decodes_json(self):
        with patch.object(api_canary, "urlopen", return_value=self.response(b'{"items":[]}', "application/json")):
            self.assertEqual(api_canary.request("GET", "/api/quiz-history")[1], {"items": []})

    def test_malformed_json_still_fails(self):
        with patch.object(api_canary, "urlopen", return_value=self.response(b"not-json", "application/json")):
            with self.assertRaises(json.JSONDecodeError):
                api_canary.request("GET", "/api/quiz-history")

    def test_no_content_delete_remains_empty(self):
        with patch.object(api_canary, "urlopen", return_value=self.response(b"", "", 204)):
            self.assertEqual(api_canary.request("DELETE", "/api/quiz-history/id")[:2], (204, None))


if __name__ == "__main__": unittest.main()
