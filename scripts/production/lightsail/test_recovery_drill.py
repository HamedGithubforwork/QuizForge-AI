from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from scripts.production.lightsail import recovery_drill as drill


class _Paginator:
    def __init__(self, pages):
        self.pages = pages

    def paginate(self, **kwargs):
        self.kwargs = kwargs
        return list(self.pages)


class _S3:
    def __init__(self, pages):
        self.paginator = _Paginator(pages)

    def get_paginator(self, name):
        if name != "list_object_versions":
            raise AssertionError(name)
        return self.paginator


class RecoveryDrillTests(unittest.TestCase):
    def test_latest_receipt_uses_newest_current_valid_version(self):
        old = datetime(2026, 9, 24, 1, tzinfo=timezone.utc)
        new = datetime(2026, 9, 25, 1, tzinfo=timezone.utc)
        pages = [{
            "Versions": [
                {
                    "Key": "receipts/" + "a" * 64 + ".json",
                    "VersionId": "old-version",
                    "IsLatest": True,
                    "LastModified": old,
                },
                {
                    "Key": "receipts/" + "b" * 64 + ".json",
                    "VersionId": "new-version",
                    "IsLatest": True,
                    "LastModified": new,
                },
                {
                    "Key": "receipts/" + "c" * 64 + ".json",
                    "VersionId": "stale-version",
                    "IsLatest": False,
                    "LastModified": datetime(2026, 9, 26, 1, tzinfo=timezone.utc),
                },
                {
                    "Key": "other/not-a-receipt.json",
                    "VersionId": "ignored",
                    "IsLatest": True,
                    "LastModified": datetime(2026, 9, 27, 1, tzinfo=timezone.utc),
                },
            ]
        }]
        s3 = _S3(pages)
        key, version = drill.latest_receipt_version(
            s3, "quizforge-production-backups-123456789012", "123456789012"
        )
        self.assertEqual(key, "receipts/" + "b" * 64 + ".json")
        self.assertEqual(version, "new-version")
        self.assertEqual(s3.paginator.kwargs["Prefix"], "receipts/")
        self.assertEqual(s3.paginator.kwargs["ExpectedBucketOwner"], "123456789012")

    def test_latest_receipt_fails_closed_when_none_exists(self):
        with self.assertRaises(ValueError):
            drill.latest_receipt_version(_S3([{"Versions": []}]), "bucket", "123456789012")

    def test_recovery_policy_has_only_read_access_to_backup_material(self):
        policy = drill.recovery_session_policy("123456789012", "36000000000-1")
        actions = []
        for statement in policy["Statement"]:
            action = statement.get("Action", [])
            actions.extend([action] if isinstance(action, str) else action)

        forbidden = (
            "s3:Put",
            "s3:Delete",
            "ssm:Put",
            "ssm:Delete",
            "route53:",
            "cognito-idp:",
            "iam:Create",
            "iam:Delete",
            "iam:Attach",
            "iam:Put",
            "ecr:Put",
            "ecr:Delete",
            "ecr:BatchDelete",
        )
        self.assertFalse(any(any(item.startswith(prefix) for prefix in forbidden) for item in actions))
        self.assertIn("s3:GetObjectVersion", actions)
        self.assertIn("s3:ListBucketVersions", actions)
        self.assertIn("ssm:GetParameter", actions)
        self.assertIn("lightsail:CreateInstances", actions)
        self.assertIn("lightsail:DeleteInstance", actions)
        self.assertIn("ecr:Get*", actions)
        self.assertIn("ecr:BatchGetImage", actions)
        self.assertIn("ecr:BatchCheckLayerAvailability", actions)
        compact = json.dumps(policy, separators=(",", ":"))
        self.assertLessEqual(len(compact), 2048)

    def test_report_rejects_private_identifiers(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "summary.json"
            with mock.patch.object(drill, "RESULT", destination):
                drill.write_report({"result": "ok"}, ["private-value"])
                self.assertEqual(json.loads(destination.read_text()), {"result": "ok"})
                with self.assertRaises(ValueError):
                    drill.write_report({"value": "private-value"}, ["private-value"])
                with self.assertRaises(ValueError):
                    drill.write_report({"value": "123456789012"}, [])
                with self.assertRaises(ValueError):
                    drill.write_report({"value": "192.0.2.10"}, [])

    def test_postgres_image_is_exact_pinned_digest(self):
        image = drill.postgres_image()
        self.assertRegex(image, r"^docker\.io/library/postgres@sha256:[a-f0-9]{64}$")
        digests = drill.release_image_digests()
        self.assertEqual(set(digests), {"api", "operations", "postgres", "redis"})
        self.assertTrue(all(value.startswith("sha256:") for value in digests.values()))

    def test_remote_failure_stage_is_bounded(self):
        error = subprocess.CalledProcessError(
            1,
            ["ssh"],
            stderr=b"private text omitted\nQF_FAILURE_STAGE=INSTALL_PYTHON_VENV\n",
        )
        self.assertEqual(drill.remote_failure_stage(error), "INSTALL_PYTHON_VENV")
        unknown = subprocess.CalledProcessError(
            1,
            ["ssh"],
            stderr=b"QF_FAILURE_STAGE=PRIVATE_SECRET_STAGE\n",
        )
        self.assertIsNone(drill.remote_failure_stage(unknown))

    def test_remote_installs_python_venv_before_creating_environment(self):
        script = Path("scripts/production/lightsail/recovery_drill_remote.sh").read_text()
        install = "apt-get install -y -qq --no-install-recommends python3-venv"
        create = 'python3 -m venv "$work/venv"'
        self.assertIn('stage="INSTALL_PYTHON_VENV"', script)
        self.assertIn(install, script)
        self.assertIn(create, script)
        self.assertLess(script.index(install), script.index(create))

    def test_remote_canary_uses_exact_loaded_runtime_and_disabled_generation(self):
        script = Path("scripts/production/lightsail/recovery_drill_remote.sh").read_text()
        self.assertIn('stage="LOAD_APPLICATION_IMAGES"', script)
        self.assertIn('docker load -i "$runtime_images"', script)
        self.assertIn('api_image="quizforge-recovery-api:locked"', script)
        self.assertIn('operations_image="quizforge-recovery-operations:locked"', script)
        self.assertIn('stage="VERIFY_RECOVERY_RUNTIME"', script)
        self.assertIn('"http://127.0.0.1:8000/api/health", 200', script)
        self.assertIn('"http://127.0.0.1:8000/api/quiz-history", 401', script)
        self.assertIn('"http://127.0.0.1:8001/identity/session", 403', script)
        self.assertIn('"http://127.0.0.1:8002/v1/responses",', script)
        self.assertIn('429,', script)
        self.assertIn('"generation_disabled_canary_passed": True', script)
        self.assertNotIn("api.openai.com", script)


if __name__ == "__main__":
    unittest.main()
