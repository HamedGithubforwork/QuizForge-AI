"""Recovery artifact preservation boundaries; synthetic, no AWS access."""
import base64
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

from scripts.production.lightsail import package_recovery as recovery


class TestRecoveryPackage(unittest.TestCase):
    def test_normal_package_remains_deterministic_and_uses_retained_active_source(self):
        content = recovery.package()
        self.assertEqual(content, recovery.package())
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            self.assertEqual(archive.namelist(), ["identity_triggers.py"])
            self.assertEqual(archive.read("identity_triggers.py"),
                             Path(recovery.__file__).with_name("identity_triggers.py").read_bytes())
            self.assertEqual(archive.getinfo("identity_triggers.py").date_time,
                             (2026, 1, 1, 0, 0, 0))

    def test_preserved_bundle_requires_exact_reviewed_source_bytes(self):
        contents = {"identity_triggers.py": b"synthetic recovery", "pre_signup.py": b"synthetic signup"}
        digests = {name: hashlib.sha256(content).hexdigest() for name, content in contents.items()}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, content in contents.items():
                (root / name).write_bytes(content)
            with patch.object(recovery, "RETAINED_SOURCES", digests):
                content = recovery.package(root)
                self.assertEqual(content, recovery.package(root))
                with zipfile.ZipFile(io.BytesIO(content)) as archive:
                    self.assertEqual(archive.namelist(), list(contents))
                    for name, expected in contents.items():
                        self.assertEqual(archive.read(name), expected)
                (root / "pre_signup.py").write_bytes(b"changed")
                with self.assertRaises(ValueError):
                    recovery.package(root)

    def configuration(self, content):
        return {
            "FunctionName": recovery.FUNCTION, "FunctionArn": recovery.FUNCTION_ARN,
            "Runtime": "python3.13", "Handler": "identity_triggers.handler", "PackageType": "Zip",
            "CodeSha256": base64.b64encode(hashlib.sha256(content).digest()).decode("ascii"),
        }

    def test_live_digest_verification_uses_only_read_operation(self):
        client = Mock()
        client.get_function_configuration.return_value = self.configuration(b"synthetic package")
        recovery.verify_deployed(client, b"synthetic package")
        client.get_function_configuration.assert_called_once_with(FunctionName=recovery.FUNCTION)
        self.assertEqual([call[0] for call in client.mock_calls], ["get_function_configuration"])

    def test_wrong_digest_function_handler_runtime_or_package_type_fail_closed(self):
        for key in self.configuration(b"synthetic package"):
            with self.subTest(key=key):
                client = Mock()
                client.get_function_configuration.return_value = {
                    **self.configuration(b"synthetic package"), key: "wrong",
                }
                with self.assertRaises(ValueError):
                    recovery.verify_deployed(client, b"synthetic package")

    def test_cli_failed_verification_preserves_existing_zip_and_hides_provider_error(self):
        import types
        client = Mock()
        client.get_function_configuration.side_effect = RuntimeError("private-token-do-not-print")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "infra/aws/lightsail-production/recovery.zip"
            destination.parent.mkdir(parents=True)
            destination.write_bytes(b"previous package")
            with patch.object(recovery, "ROOT", root), \
                    patch.object(recovery, "package", return_value=b"candidate package"), \
                    patch.dict("sys.modules", {"boto3": types.SimpleNamespace(client=lambda *a, **kw: client)}), \
                    patch("sys.argv", ["packager", "--retained-production-source", str(root), "--verify-deployed"]), \
                    self.assertRaises(SystemExit) as error:
                recovery.main()
            self.assertEqual(destination.read_bytes(), b"previous package")
            self.assertNotIn("private-token", str(error.exception))

    def test_cli_rejects_live_check_without_pinned_source(self):
        with patch("sys.argv", ["packager", "--verify-deployed"]), \
                patch("sys.stderr", io.StringIO()), self.assertRaises(SystemExit):
            recovery.main()

    def test_protected_plan_preserves_archive_and_read_only_permissions(self):
        workflow = (recovery.ROOT / ".github/workflows/production-google-terraform-plan.yml").read_text()
        self.assertIn("43894cc78eaa4b7da94fd4375bd929d64addca6b", workflow)
        self.assertIn("--retained-production-source", workflow)
        self.assertIn("--verify-deployed", workflow)
        self.assertIn("lambda:GetFunctionConfiguration", workflow)
        self.assertIn(recovery.FUNCTION_ARN, workflow)
        self.assertNotIn("lambda:UpdateFunction", workflow)
        self.assertNotIn("terraform apply", workflow)


if __name__ == "__main__":
    unittest.main()
