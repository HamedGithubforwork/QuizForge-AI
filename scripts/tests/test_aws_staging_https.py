from datetime import datetime, timedelta, timezone
from itertools import product
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aws_staging_https import aws_diagnostic, covers, live, registered_domain_count, settings, validate_certificate, validate_zone

NOW = datetime(2026, 9, 19, tzinfo=timezone.utc)
HOST = "staging-api.example.com"
ACCOUNT = "123456789012"
ARN = "arn:aws:acm:ca-central-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"


class HttpsSafety(unittest.TestCase):
    def setUp(self):
        self.env = {"TF_VAR_staging_hostname": HOST, "TF_VAR_staging_certificate_arn": ARN,
                    "TF_VAR_staging_zone_id": "Z1234"}
        self.certificate = {"CertificateArn": ARN, "Status": "ISSUED", "Type": "AMAZON_ISSUED",
                            "SubjectAlternativeNames": [HOST], "NotBefore": NOW - timedelta(days=1),
                            "NotAfter": NOW + timedelta(days=60)}
        self.zone = {"Name": "example.com.", "Config": {"PrivateZone": False}}

    def test_valid_dedicated_configuration(self):
        self.assertEqual(settings(self.env), (HOST, ARN, "Z1234"))
        validate_certificate(self.certificate, HOST, ARN, ACCOUNT, NOW)
        validate_zone(self.zone, HOST, [])

    def test_partial_configuration_rejected(self):
        for key in self.env:
            with self.subTest(key=key), self.assertRaises(ValueError):
                settings({**self.env, key: ""})

    def test_production_hostnames_and_urls_rejected(self):
        for host in ("example.com", "api.example.com", "staging-api.example.com/", "https://" + HOST,
                     "STAGING-API.example.com", "staging-api.example.com@other.test"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                settings({**self.env, "TF_VAR_staging_hostname": host})

    def test_certificate_region_and_account_must_match(self):
        with self.assertRaises(ValueError):
            settings({**self.env, "TF_VAR_staging_certificate_arn": ARN.replace("ca-central-1", "us-east-1")})
        with self.assertRaises(ValueError):
            validate_certificate(self.certificate, HOST, ARN, "999999999999", NOW)

    def test_certificate_must_be_issued_public_valid_and_cover_host(self):
        for key, value in (("Status", "PENDING_VALIDATION"), ("Type", "PRIVATE"),
                           ("CertificateArn", ARN + "x"), ("NotAfter", NOW),
                           ("NotBefore", NOW + timedelta(days=1)),
                           ("SubjectAlternativeNames", ["other.example.com"])):
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_certificate({**self.certificate, key: value}, HOST, ARN, ACCOUNT, NOW)

    def test_wildcard_matches_one_label_only(self):
        self.assertTrue(covers("*.example.com", HOST))
        for host in ("example.com", "staging-api.nested.example.com", "staging-api.fakeexample.com"):
            self.assertFalse(covers("*.example.com", host))

    def test_private_wrong_and_apex_zones_rejected(self):
        for zone in ({**self.zone, "Config": {"PrivateZone": True}},
                     {**self.zone, "Name": "fakeexample.com."}, {**self.zone, "Name": HOST + "."}):
            with self.assertRaises(ValueError):
                validate_zone(zone, HOST, [])

    def test_existing_records_of_any_type_are_preserved(self):
        for record_type in ("A", "AAAA", "CNAME", "TXT"):
            with self.subTest(record_type=record_type), self.assertRaises(ValueError):
                validate_zone(self.zone, HOST, [{"Name": HOST + ".", "Type": record_type}])

    def test_read_only_diagnostic_preserves_error_and_redacts_identity(self):
        error = RuntimeError()
        error.operation_name = "ListDomains"
        error.response = {"Error": {"Code": "AccessDeniedException", "Message":
                          "Denied for arn:aws:sts::123456789012:assumed-role/test/run user@example.com account 123456789012"}}
        diagnostic = aws_diagnostic(error)
        self.assertIn("operation=ListDomains error=AccessDeniedException", diagnostic)
        self.assertNotIn(ACCOUNT, diagnostic)
        self.assertNotIn("user@example.com", diagnostic)
        error.operation_name = "DescribeCertificate"
        self.assertNotIn("Denied for", aws_diagnostic(error))

    def test_unsupported_registrar_is_unknown_never_zero(self):
        error = RuntimeError()
        error.operation_name = "ListDomains"
        error.response = {"Error": {"Code": "AccessDeniedException",
                                   "Message": "Free Tier accounts are not supported for this service"}}
        registrar = Mock()
        registrar.get_paginator.return_value.paginate.side_effect = error
        self.assertIsNone(registered_domain_count(registrar))
        # Ordinary IAM denial must never be mistaken for the Free Tier restriction.
        error.response["Error"]["Message"] = "Identity policy does not permit this action"
        with self.assertRaises(RuntimeError):
            registered_domain_count(registrar)
        error.response["Error"]["Code"] = "ThrottlingException"
        with self.assertRaises(RuntimeError):
            registered_domain_count(registrar)

    def test_registrar_count_includes_all_pages(self):
        registrar = Mock()
        registrar.get_paginator.return_value.paginate.return_value = [
            {"Domains": [{"DomainName": "example.com"}]}, {"Domains": [{"DomainName": "example.org"}]}]
        self.assertEqual(registered_domain_count(registrar), 2)

    def run_live_probe(self, responses):
        outputs = {"api_url": {"value": "https://" + HOST},
                   "api_http_url": {"value": "http://quizforge-staging-api-123.ca-central-1.elb.amazonaws.com"}}
        with patch.dict(os.environ, self.env, clear=True), \
                patch("aws_staging_https.subprocess.check_output", return_value=json.dumps(outputs)), \
                patch("aws_staging_https.request", side_effect=responses) as request:
            live()
        return request

    def live_responses(self, first_port="", second_port=""):
        suffix = "/api/health?https_probe=1"
        return [(301, {"Location": "https://" + HOST + first_port + suffix}, b""),
                (301, {"Location": "https://" + HOST + second_port + suffix}, b""),
                (200, {}, b'{"status":"ok"}'), (401, {}, b""), (404, {}, b"")]

    def test_live_accepts_explicit_and_implicit_default_https_port(self):
        # ALB's observed Location includes :443; both spellings use the same origin.
        for ports in product(("", ":443"), repeat=2):
            with self.subTest(ports=ports):
                request = self.run_live_probe(self.live_responses(*ports))
                self.assertEqual(request.call_args_list, [
                    call("http://quizforge-staging-api-123.ca-central-1.elb.amazonaws.com/api/health?https_probe=1"),
                    call("http://" + HOST + "/api/health?https_probe=1"),
                    call("https://" + HOST + "/api/health"),
                    call("https://" + HOST + "/api/documents/" + "0" * 64 + "/pages/1"),
                    call("https://" + HOST + "/api/health", {"Host": "unrelated.invalid"}),
                ])

    def test_live_rejects_unsafe_or_changed_redirects_from_either_origin(self):
        suffix = "/api/health?https_probe=1"
        destination = "https://" + HOST + ":443" + suffix
        invalid = [(code, destination) for code in (200, 302, 307, 308)]
        invalid += [(301, location) for location in (
            None, "", "http://" + HOST + suffix, "//" + HOST + suffix,
            "https://unrelated.invalid" + suffix,
            "https://" + HOST + ".unrelated.invalid" + suffix,
            "https://" + HOST + ":8443" + suffix,
            "https://" + HOST + ":80" + suffix,
            "https://user@" + HOST + ":443" + suffix,
            "https://" + HOST + "@unrelated.invalid" + suffix,
            "https://" + HOST + ":443/other?https_probe=1",
            "https://" + HOST + ":443/api/health",
            destination + "&extra=1", destination + "#fragment",
        )]
        for index, (status, location) in product(range(2), invalid):
            with self.subTest(origin=index, status=status, location=location):
                responses = self.live_responses(":443", ":443")
                responses[index] = (status, {"Location": location}, b"")
                with self.assertRaisesRegex(ValueError, "HTTP must redirect"):
                    self.run_live_probe(responses)

    def test_live_retains_health_authentication_and_host_isolation_checks(self):
        for index, response, message in (
            (2, (503, {}, b""), "health probe failed"),
            (2, (200, {}, b"[]"), "health probe failed"),
            (3, (200, {}, b""), "Protected route"),
            (4, (200, {}, b""), "Unexpected Host"),
        ):
            with self.subTest(probe=index, response=response):
                responses = self.live_responses(":443", ":443")
                responses[index] = response
                with self.assertRaisesRegex(ValueError, message):
                    self.run_live_probe(responses)


if __name__ == "__main__":
    unittest.main()
