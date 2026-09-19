from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aws_staging_https import aws_diagnostic, covers, registered_domain_count, settings, validate_certificate, validate_zone

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


if __name__ == "__main__":
    unittest.main()
