import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError


SCRIPT = Path(__file__).resolve().parents[1] / "aws_staging_functional.py"
spec = importlib.util.spec_from_file_location("staging", SCRIPT)
staging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging)


class StagingGuardrailTests(unittest.TestCase):
    def test_only_temporary_canadian_alb_is_accepted(self):
        host = "quizforge-staging-api-123.ca-central-1.elb.amazonaws.com"
        self.assertEqual(staging.validate_staging_url("http://" + host + "/"), "http://" + host)
        for url in (
            "https://quizforge-ai-api.onrender.com", "http://127.0.0.1:8000",
            "http://quizforge-staging-api-123.us-east-1.elb.amazonaws.com",
            "http://" + host + ".attacker.example", "http://user:secret@" + host,
            "http://" + host + "?next=production", "http://" + host + "/api",
        ):
            with self.subTest(url=url), self.assertRaises(staging.ValidationError):
                staging.validate_staging_url(url)

    def test_pdf_has_correct_cross_reference_and_unique_identity(self):
        first = staging.make_pdf("first-run")
        self.assertNotEqual(first, staging.make_pdf("second-run"))
        xref_position = int(first.split(b"startxref\n")[1].splitlines()[0])
        self.assertEqual(first[xref_position:xref_position + 4], b"xref")
        lines = first[xref_position:].splitlines()
        for number, row in enumerate(lines[3:8], 1):
            offset = int(row[:10])
            self.assertTrue(first[offset:].startswith(f"{number} 0 obj".encode()))

    def test_unexpected_http_response_does_not_leak_body(self):
        error = HTTPError("http://example/api", 500, "server error", {}, io.BytesIO(b'{"secret":"do-not-log"}'))
        with patch.object(staging, "urlopen", side_effect=error):
            with self.assertRaises(staging.ValidationError) as caught:
                staging.request("http://example/api")
        self.assertNotIn("do-not-log", str(caught.exception))
        self.assertIn("expected 200, got 500", str(caught.exception))

    def test_expected_429_exposes_retry_after_to_assertion(self):
        error = HTTPError("http://example/api", 429, "limited", {"Retry-After": "42"}, io.BytesIO(b'{"detail":"limited"}'))
        with patch.object(staging, "urlopen", side_effect=error):
            _, headers = staging.request("http://example/api", expected=429)
        self.assertEqual(headers["Retry-After"], "42")

    def test_failed_private_probe_is_stopped(self):
        outputs = {"ecs_cluster_name": "staging", "ecs_task_definition_arn": "task-def",
                   "public_subnet_ids": ["subnet"], "app_security_group_id": "group"}
        responses = [{"tasks": [{"taskArn": "test-task"}]},
                     {"tasks": [{"lastStatus": "STOPPED", "containers": [{"exitCode": 1}]}]}, {}]
        with patch.object(staging, "aws", side_effect=responses) as aws:
            with self.assertRaises(staging.ValidationError):
                staging.run_private_probe(outputs, {"run_id": "test"})
        self.assertEqual(aws.call_args.args[:2], ("ecs", "stop-task"))
        launch_args = aws.call_args_list[0].args
        overrides = json.loads(launch_args[launch_args.index("--overrides") + 1])
        self.assertLess(len(json.dumps(overrides)), 8192)
        self.assertEqual(overrides["containerOverrides"][0]["environment"], [
            {"name": "STAGING_PROBE_CONTEXT", "value": '{"run_id": "test"}'}])


if __name__ == "__main__":
    unittest.main()
