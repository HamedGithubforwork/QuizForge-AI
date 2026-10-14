import io
import json
import unittest
import urllib.error
from unittest.mock import Mock

from scripts.production.lightsail.google_client_probe import ENDPOINT, INVALID_CODE, NoRedirect, inspect, probe
from scripts.production.lightsail.test_google_provider_readiness import GOOGLE_ID, SECRET


def error(code, body):
    return urllib.error.HTTPError(ENDPOINT, code, "private error", {}, io.BytesIO(body))


class ProbeTests(unittest.TestCase):
    def test_discriminating_control_and_exact_request_scope(self):
        opener = Mock()
        opener.open.side_effect = [error(400, b'{"error":"invalid_grant"}'), error(401, b'{"error":"invalid_client"}')]
        result = inspect(GOOGLE_ID, SECRET, opener=opener)
        self.assertTrue(result["credential_check_distinguishes_secrets"])
        self.assertNotIn(SECRET, json.dumps(result))
        for call in opener.open.call_args_list:
            req = call.args[0]
            self.assertEqual(req.full_url, ENDPOINT)
            self.assertEqual(req.method, "POST")
            self.assertIn(INVALID_CODE.encode(), req.data)
            self.assertEqual(call.kwargs["timeout"], 15)

    def test_same_rejections_are_not_proof_of_valid_credentials(self):
        for response in ("invalid_client", "invalid_grant"):
            opener = Mock()
            opener.open.side_effect = [error(400, json.dumps({"error": response}).encode()) for _ in range(2)]
            self.assertFalse(inspect(GOOGLE_ID, SECRET, opener=opener)["credential_check_distinguishes_secrets"])

    def test_private_unknown_malformed_oversized_and_redirect_responses_are_redacted(self):
        for status, body in [(400, json.dumps({"error":SECRET, "error_description":SECRET}).encode()),
                             (400, b'not json'), (400, b'x' * 4097), (302, b'{"error":"invalid_client"}')]:
            opener = Mock()
            opener.open.side_effect = error(status, body)
            self.assertEqual(probe(GOOGLE_ID, SECRET, opener=opener), "unclassified_response")
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.invalid"))

    def test_network_errors_do_not_leak_exception_text(self):
        opener = Mock()
        opener.open.side_effect = RuntimeError(SECRET)
        self.assertEqual(probe(GOOGLE_ID, SECRET, opener=opener), "network_unavailable")

    def test_unexpected_success_is_never_read_or_accepted(self):
        opener = Mock()
        response = Mock()
        opener.open.return_value.__enter__ = Mock(return_value=response)
        opener.open.return_value.__exit__ = Mock(return_value=False)
        self.assertEqual(probe(GOOGLE_ID, SECRET, opener=opener), "unexpected_success")
        response.read.assert_not_called()

    def test_missing_credentials_fail_before_network(self):
        opener = Mock()
        with self.assertRaises(ValueError):
            probe(GOOGLE_ID, "", opener=opener)
        opener.open.assert_not_called()


if __name__ == "__main__":
    unittest.main()
