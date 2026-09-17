import unittest
from unittest.mock import Mock

from botocore.exceptions import ClientError
from cognito_profile import expect_error, totp


class CognitoGuardTests(unittest.TestCase):
    def test_totp_matches_rfc6238_sha1_test_vectors_modulo_six_digits(self):
        key = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
        for timestamp, code in ((59, "287082"), (1111111109, "081804"),
                                (1111111111, "050471"), (1234567890, "005924"),
                                (2000000000, "279037"), (20000000000, "353130")):
            self.assertEqual(totp(key, timestamp), code)

    def test_negative_checks_fail_if_operation_succeeds_or_wrong_rejection(self):
        with self.assertRaises(AssertionError): expect_error("InvalidPasswordException", Mock(return_value={}))
        for code in ("AccessDeniedException", "TooManyRequestsException"):
            operation = Mock(side_effect=ClientError({"Error": {"Code": code}}, "operation"))
            with self.assertRaises(AssertionError): expect_error("InvalidPasswordException", operation)

    def test_negative_check_requires_expected_aws_error(self):
        operation = Mock(side_effect=ClientError({"Error": {"Code": "InvalidPasswordException"}}, "operation"))
        expect_error("InvalidPasswordException", operation)


if __name__ == "__main__": unittest.main()
