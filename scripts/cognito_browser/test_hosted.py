import contextlib
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

import control
import hosted
import recovery


class HostedHandoffTests(unittest.TestCase):
    def setUp(self):
        self.state = {"pool": "pool", "client": "client", "fixture_client": "fixture", "domain": "temporary",
                      "recovery_run": "42", "deadline": (datetime.now(timezone.utc) + timedelta(minutes=20)).isoformat()}
        self.bundle = {**self.state, "controller_sha": "reviewed-sha", "recovery": {"mode": "live"}}
        self.data = {**self.state, "controller_sha": "reviewed-sha", "code": "654321"}

    def parameter(self, **changes):
        return {"Name": recovery.HOSTED_RECEIPT, "Type": "SecureString", "Value": json.dumps({**self.data, **changes})}

    def test_receipt_rejects_expired_wrong_run_malformed_and_extra_keys(self):
        for defect in (None, "run", "expired", "code", "extra"):
            state = dict(self.state)
            value = {"run_id": "42", "code": "654321"}
            if defect == "run": value["run_id"] = "41"
            if defect == "expired": state["deadline"] = "1970-01-01T00:00:00Z"
            if defect == "code": value["code"] = "bad\nvalue"
            if defect == "extra": value["extra"] = "unsafe"
            with self.subTest(defect=defect), patch.dict(os.environ, {"COGNITO_RECOVERY_RECEIPT": json.dumps(value)}):
                if defect:
                    with self.assertRaises(AssertionError): hosted.receipt(state)
                else: self.assertEqual(hosted.receipt(state), value)

    def test_delivery_requires_exact_pool_clients_run_controller_and_encryption(self):
        self.assertEqual(hosted.validate_delivery(self.parameter(), self.bundle), "654321")
        for field in (*hosted.BINDINGS, "controller_sha", "code", "extra"):
            with self.subTest(field=field), self.assertRaises(AssertionError):
                hosted.validate_delivery(self.parameter(**{field: "wrong"}), self.bundle)
        for changes in ({"Type": "String"}, {"Name": "unrelated"}, {"Value": "x" * 4097}):
            with self.subTest(changes=list(changes)), self.assertRaises(AssertionError):
                hosted.validate_delivery({**self.parameter(), **changes}, self.bundle)
        with self.assertRaises(AssertionError):
            hosted.validate_delivery(self.parameter(), {**self.bundle, "deadline": "1970-01-01T00:00:00Z"})

    def test_accept_encrypts_only_one_exact_standard_parameter_without_overwrite(self):
        env = {"GITHUB_SHA": "reviewed-sha", "COGNITO_RECOVERY_RECEIPT": json.dumps({"run_id": "42", "code": "654321"})}
        with patch.dict(os.environ, env), patch.object(control, "values", return_value=self.state), \
                patch.object(recovery, "ssm") as ssm, contextlib.redirect_stdout(io.StringIO()) as output:
            hosted.accept()
            call = ssm.return_value.put_parameter.call_args.kwargs
            self.assertEqual(call["Name"], recovery.HOSTED_RECEIPT)
            self.assertEqual(call["Type"], "SecureString")
            self.assertEqual(call["Tier"], "Standard")
            self.assertFalse(call["Overwrite"])
            self.assertEqual(json.loads(call["Value"]), self.data)
            self.assertNotIn("654321", output.getvalue())

    def deliver(self, provider):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "hosted-handoff").mkdir(mode=0o700)
            Path(tmp, "cognito-browser-bundle.json").write_text(json.dumps(self.bundle))
            with patch.dict(os.environ, {"RUNNER_TEMP": tmp}), patch.object(recovery, "ssm", return_value=provider), \
                    patch.object(hosted.time, "sleep"), contextlib.redirect_stdout(io.StringIO()) as output:
                hosted.deliver()
                file = Path(tmp, "hosted-handoff/receipt.json")
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
                self.assertEqual(json.loads(file.read_text()), {"code": "654321"})
                self.assertFalse(Path(tmp, "hosted-handoff/receipt.tmp").exists())
                self.assertNotIn("654321", output.getvalue())

    def test_delivery_waits_only_for_missing_parameter_then_atomically_writes(self):
        provider = Mock()
        provider.get_parameter.side_effect = [ClientError({"Error": {"Code": "ParameterNotFound"}}, "GetParameter"),
                                              {"Parameter": self.parameter()}]
        self.deliver(provider)
        for call in provider.get_parameter.call_args_list:
            self.assertEqual(call.kwargs, {"Name": recovery.HOSTED_RECEIPT, "WithDecryption": True})

    def test_delivery_fails_closed_on_binding_mismatch_and_provider_errors(self):
        provider = Mock()
        provider.get_parameter.return_value = {"Parameter": self.parameter(pool="wrong")}
        with self.assertRaises(AssertionError): self.deliver(provider)
        provider.get_parameter.side_effect = ClientError({"Error": {"Code": "AccessDeniedException"}}, "GetParameter")
        with self.assertRaises(AssertionError): self.deliver(provider)


if __name__ == "__main__":
    unittest.main()
