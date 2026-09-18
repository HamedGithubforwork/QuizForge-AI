import base64
import contextlib
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zlib

import control
import hosted
import recovery


class HostedHandoffTests(unittest.TestCase):
    def setUp(self):
        self.state = {"pool": "pool", "client": "client", "fixture_client": "fixture", "domain": "temporary",
                      "recovery_run": "42", "deadline": (datetime.now(timezone.utc) + timedelta(minutes=20)).isoformat()}
        self.host = "temporary.auth.ca-central-1.amazoncognito.com"
        self.continuation = {"url": "https://" + self.host + "/confirmForgotPassword?client_id=client",
                             "cookies": [{"name": "XSRF-TOKEN", "value": "private-cookie", "domain": self.host, "secure": True, "path": "/"}]}
        self.bundle = {**self.state, "controller_sha": "reviewed-sha", "continuation": self.continuation,
                       "users": {"mapped": {"email": "inbox@example.test", "password": "private-password"}}}

    def parameters(self, bundle=None):
        raw = json.dumps(bundle or self.bundle).encode()
        return [{"Name": recovery.HOSTED_PARAMETERS[0], "Type": "SecureString",
                 "Value": base64.b64encode(zlib.compress(raw)).decode()}]

    def test_continuation_rejects_wrong_origin_client_path_and_cookie_scope(self):
        hosted.check_continuation(self.continuation, self.state)
        for url in ("http://" + self.host + "/confirmForgotPassword?client_id=client",
                    "https://evil.example/confirmForgotPassword?client_id=client",
                    "https://" + self.host + "/login?client_id=client",
                    "https://" + self.host + "/confirmForgotPassword?client_id=other"):
            with self.subTest(url=url), self.assertRaises(AssertionError):
                hosted.check_continuation({**self.continuation, "url": url}, self.state)
        for defect in ({"domain": ".amazoncognito.com"}, {"secure": False}, {"value": "x" * 8001}):
            cookie = {**self.continuation["cookies"][0], **defect}
            with self.subTest(defect=list(defect)), self.assertRaises(AssertionError):
                hosted.check_continuation({**self.continuation, "cookies": [cookie]}, self.state)

    def test_encrypted_roundtrip_requires_complete_bounded_chunks(self):
        self.assertEqual(hosted.decode(self.parameters()), self.bundle)
        for defect in ("plaintext", "gap", "oversize", "truncated", "trailing", "bomb"):
            params = self.parameters()
            item = params[0]
            if defect == "plaintext": item["Type"] = "String"
            if defect == "gap": item["Name"] = recovery.HOSTED_PARAMETERS[1]
            if defect == "oversize": item["Value"] = "a" * 4097
            if defect == "truncated": item["Value"] = base64.b64encode(zlib.compress(b"{}")[0:4]).decode()
            if defect == "trailing": item["Value"] = base64.b64encode(zlib.compress(b"{}") + b"extra").decode()
            if defect == "bomb": item["Value"] = base64.b64encode(zlib.compress(b"x" * (hosted.LIMIT + 1))).decode()
            with self.subTest(defect=defect), self.assertRaises(AssertionError): hosted.decode(params)

    def test_load_binds_receipt_pool_controller_and_inbox_before_writing_secrets(self):
        for defect in (None, "run", "expired", "pool", "controller", "inbox"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as tmp:
                state = dict(self.state)
                bundle = json.loads(json.dumps(self.bundle))
                receipt = {"run_id": "42", "code": "654321"}
                if defect == "run": receipt["run_id"] = "41"
                if defect == "expired": state["deadline"] = "1970-01-01T00:00:00Z"
                if defect == "pool": bundle["pool"] = "another-pool"
                if defect == "controller": bundle["controller_sha"] = "unreviewed"
                if defect == "inbox": bundle["users"]["mapped"]["email"] = "other@example.test"
                env = {"RUNNER_TEMP": tmp, "GITHUB_SHA": "reviewed-sha", "GITHUB_ENV": str(Path(tmp)/"env"),
                       "COGNITO_REHEARSAL_EMAIL": "inbox@example.test", "COGNITO_RECOVERY_RECEIPT": json.dumps(receipt)}
                with patch.dict(os.environ, env), patch.object(control, "values", return_value=state), \
                        patch.object(recovery, "ssm") as ssm, patch.object(control, "configuration"), \
                        patch.object(hosted.boto3, "client"), contextlib.redirect_stdout(io.StringIO()) as output:
                    ssm.return_value.get_parameters.return_value = {"Parameters": self.parameters(bundle)}
                    if defect:
                        with self.assertRaises(AssertionError): hosted.load()
                        self.assertFalse((Path(tmp)/"cognito-browser-bundle.json").exists())
                        if defect in ("run", "expired"): ssm.assert_not_called()
                    else:
                        hosted.load()
                        file = Path(tmp)/"cognito-browser-bundle.json"
                        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
                        self.assertEqual(json.loads(file.read_text())["recovery"], {"mode": "finish", "code": "654321"})
                        self.assertEqual((Path(tmp)/"env").read_text(), "HOSTED_IMAGE_RUN=42\n")
                        ssm.return_value.get_parameters.assert_called_once_with(Names=recovery.HOSTED_PARAMETERS, WithDecryption=True)
                    for secret in ("654321", "private-cookie", "private-password", "inbox@example.test"):
                        self.assertNotIn(secret, output.getvalue())

    def test_save_uses_only_standard_securestrings_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle = {**self.bundle, "recovery": {"mode": "start"}}
            bundle.pop("continuation")
            Path(tmp, "cognito-browser-bundle.json").write_text(json.dumps(bundle))
            Path(tmp, "hosted-handoff").mkdir()
            Path(tmp, "hosted-handoff/continuation.json").write_text(json.dumps(self.continuation))
            env = {"RUNNER_TEMP": tmp, "GITHUB_STEP_SUMMARY": str(Path(tmp)/"summary")}
            with patch.dict(os.environ, env), patch.object(control, "values", return_value=self.state), \
                    patch.object(recovery, "ssm") as ssm, contextlib.redirect_stdout(io.StringIO()):
                ssm.return_value.get_parameters.return_value = {"Parameters": []}
                hosted.save()
                calls = ssm.return_value.put_parameter.call_args_list
                self.assertGreater(len(calls), 0)
                for call in calls:
                    self.assertEqual(call.kwargs["Type"], "SecureString")
                    self.assertEqual(call.kwargs["Tier"], "Standard")
                    self.assertFalse(call.kwargs["Overwrite"])
                    self.assertIn(call.kwargs["Name"], recovery.HOSTED_PARAMETERS)
                ssm.return_value.put_parameter.reset_mock()
                ssm.return_value.get_parameters.return_value = {"Parameters": self.parameters()}
                with self.assertRaises(AssertionError): hosted.save()
                ssm.return_value.put_parameter.assert_not_called()


if __name__ == "__main__":
    unittest.main()
