import copy
import http.server
import threading
import unittest
from local_inference import validate_quiz, request, payload, FIXTURES, SCHEMA


def valid_quiz():
    return {"title": "Synthetic", "questions": [
        {"question_type": "multiple_choice", "question": f"Question {i}?",
         "choices": ["A", "B", "C", "D"], "correct_index": 0,
         "explanation": "A is stated on page one.", "source_pages": [1]}
        for i in range(5)]}


class ValidationTests(unittest.TestCase):
    def test_runtime_schema_contract(self):
        body = payload(FIXTURES[0])
        self.assertEqual(body["json_schema"], SCHEMA)
        self.assertFalse(body["stream"])
        self.assertNotIn("response_format", body)

    def test_valid(self):
        self.assertEqual(validate_quiz(valid_quiz(), {1}), [])

    def test_invalid_output(self):
        for field, value in [("correct_index", True), ("correct_index", 4),
                             ("source_pages", [2]), ("source_pages", [True]),
                             ("choices", ["A", "a ", "C", "D"]),
                             ("choices", [None] * 4), ("explanation", ""),
                             ("question_type", "short_answer")]:
            with self.subTest(field=field, value=value):
                quiz = valid_quiz(); quiz["questions"][0][field] = value
                self.assertTrue(validate_quiz(quiz, {1}))

    def test_duplicates_and_unknown_fields(self):
        quiz = valid_quiz(); quiz["questions"][1] = copy.deepcopy(quiz["questions"][0])
        self.assertIn("1:duplicate_question", validate_quiz(quiz, {1}))
        quiz = valid_quiz(); quiz["questions"][0]["url"] = "https://example.com"
        self.assertIn("0:question_fields", validate_quiz(quiz, {1}))

    def test_malformed_root(self):
        for value in [None, [], {}, {"title": "A", "questions": None}]:
            self.assertTrue(validate_quiz(value, {1}))

    def test_local_transport_rejects_redirect_and_oversize(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            status = 302
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_response(self.status)
                self.send_header('Location', 'https://example.com')
                self.end_headers()
                if self.status == 200:
                    self.wfile.write(b'x' * 262145)
            def log_message(self, *_):
                pass
        server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with self.assertRaisesRegex(ValueError, 'http_error'):
                request(server.server_port, {}, 2)
            Handler.status = 200
            with self.assertRaisesRegex(ValueError, 'too_large'):
                request(server.server_port, {}, 2)
        finally:
            server.shutdown();server.server_close();thread.join()


if __name__ == '__main__':
    unittest.main()
