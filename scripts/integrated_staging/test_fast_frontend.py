"""Fast frontend refresh has no production or infrastructure write path."""
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from fast_frontend import REQUIRED, NAME, checked_config, publish


class FastFrontendChecks(unittest.TestCase):
    def values(self, now=None):
        deadline = (now or datetime.now(timezone.utc)) + timedelta(hours=1)
        return {
            "name": NAME, "pool": "ca-central-1_Test", "client": "browserclient123",
            "auth_domain": "quizforge-integrated-123456789012",
            "domain": "d123.cloudfront.net", "api_url": "https://staging-api.quizfromnotes.com",
            "deadline": deadline.isoformat(), "bucket": "quizforge-integrated-staging-123456789012",
        }

    def test_valid_state_and_lease(self):
        now = datetime.now(timezone.utc)
        self.assertEqual(checked_config(list(REQUIRED), self.values(now), now)["client"], "browserclient123")

    def test_absent_partial_foreign_and_production_resources_fail_closed(self):
        with self.assertRaises(ValueError):
            checked_config([], self.values())
        with self.assertRaises(ValueError):
            checked_config(["aws_s3_bucket.site"], self.values())
        with self.assertRaises(AssertionError):
            checked_config(list(REQUIRED) + ["aws_db_instance.production"], self.values())
        with self.assertRaises(ValueError):
            checked_config(list(REQUIRED), {**self.values(), "name": "production"})

    def test_wrong_api_pool_and_expiring_or_extended_lease_fail_closed(self):
        now = datetime.now(timezone.utc)
        for changes in (
            {"api_url": "https://api.quizfromnotes.com"},
            {"pool": "us-east-1_Test"},
            {"domain": "d123.cloudfront.net.evil.test"},
            {"deadline": (now + timedelta(minutes=9)).isoformat()},
            {"deadline": (now + timedelta(hours=4)).isoformat()},
            {"deadline": (now - timedelta(seconds=1)).isoformat()},
        ):
            with self.subTest(changes=changes), self.assertRaises((AssertionError, ValueError)):
                checked_config(list(REQUIRED), {**self.values(now), **changes}, now)

    def test_refresh_rejects_a_different_staging_pool_before_writing(self):
        now = datetime.now(timezone.utc)
        original = checked_config(list(REQUIRED), self.values(now), now)
        changed = {**original, "client": "changedclient"}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / "integration-config.json").write_text(json.dumps(changed))
            current = os.getcwd()
            try:
                os.chdir(path)
                with patch("fast_frontend.live", return_value=(self.values(now), original)), (
                    patch("fast_frontend.control.client") as aws
                ), self.assertRaises(ValueError):
                    publish()
                aws.assert_not_called()
            finally:
                os.chdir(current)

    def test_refresh_rejects_invalid_artifact_manifest_before_writing(self):
        now = datetime.now(timezone.utc)
        config = checked_config(list(REQUIRED), self.values(now), now)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "integration-config.json").write_text(json.dumps(config))
            (root / "hosting-manifest.json").write_text(json.dumps({"index.html": {"sha256": "bad"}}))
            current = os.getcwd()
            try:
                os.chdir(root)
                with patch("fast_frontend.live", return_value=(self.values(now), config)), (
                    patch("fast_frontend.control.hosting.inventory", return_value={"index.html": {"sha256": "real"}})
                ), patch("fast_frontend.control.client") as aws, self.assertRaises(ValueError):
                    publish()
                aws.assert_not_called()
            finally:
                os.chdir(current)

    def test_refresh_publishes_html_last_and_preserves_prior_assets(self):
        class NotFound(Exception):
            pass

        now = datetime.now(timezone.utc)
        config = checked_config(list(REQUIRED), self.values(now), now)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "hosting-dist" / "assets").mkdir(parents=True)
            (root / "hosting-dist" / "index.html").write_bytes(b"<html>new test page with enough text</html>")
            (root / "hosting-dist" / "assets" / "new.js").write_bytes(b"console.log('new')")
            files = {"assets/new.js": {"sha256": "synthetic"}, "index.html": {"sha256": "synthetic"}}
            (root / "integration-config.json").write_text(json.dumps(config))
            (root / "hosting-manifest.json").write_text(json.dumps(files))
            s3 = MagicMock()
            s3.exceptions.NoSuchKey = NotFound
            def read_existing(*, Key, **kwargs):
                if Key.startswith("assets/"):
                    raise NotFound()
                return {"Body": io.BytesIO((root / "hosting-dist" / "index.html").read_bytes())}
            s3.get_object.side_effect = read_existing
            page = MagicMock()
            page.status = 200
            page.read.return_value = (root / "hosting-dist" / "index.html").read_bytes()
            endpoint = MagicMock()
            endpoint.__enter__.return_value = page
            current = os.getcwd()
            try:
                os.chdir(root)
                with patch("fast_frontend.live", return_value=(self.values(now), config)), (
                    patch("fast_frontend.control.hosting.inventory", return_value=files)
                ), patch("fast_frontend.control.client", return_value=s3), (
                    patch("fast_frontend.urlopen", return_value=endpoint)
                ), patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(root / "summary.md")}):
                    publish()
                self.assertEqual(
                    [call.kwargs["Key"] for call in s3.put_object.call_args_list],
                    ["assets/new.js", "index.html"],
                )
                self.assertIn("d123.cloudfront.net", (root / "summary.md").read_text())
            finally:
                os.chdir(current)


if __name__ == "__main__":
    unittest.main()
