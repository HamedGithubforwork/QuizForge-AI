"""Fail closed if staging's reviewed feature branch lacks current app baseline."""
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import aws_staging_preview as preview

BASE = "a" * 40
HEAD = "b" * 40


def comparison(**overrides):
    return {
        "status": "ahead", "behind_by": 0,
        "base_commit": {"sha": BASE},
        "head_commit": {"sha": HEAD},
        "merge_base_commit": {"sha": BASE},
        **overrides,
    }


class StagingApplicationBaseline(unittest.TestCase):
    def test_expected_production_snapshot_and_feature_head(self):
        self.assertEqual(preview.verify_latest_production_baseline(
            comparison(), HEAD, BASE), HEAD)

    def test_rejects_stale_diverged_or_mismatched_heads(self):
        bad = [
            comparison(status="diverged", behind_by=2),
            comparison(status="behind", behind_by=1),
            comparison(status="ahead", behind_by=1),
            comparison(base_commit={"sha": "c" * 40}),
            comparison(merge_base_commit={"sha": "c" * 40}),
            {},
        ]
        for case in bad:
            with self.subTest(case=case), self.assertRaises(ValueError):
                preview.verify_latest_production_baseline(case, HEAD, BASE)

    def test_checking_pr_does_not_accept_green_tests_with_stale_base(self):
        # The ancestry check runs AFTER exact-head PR CI verification.
        pr = {
            "state": "open",
            "base": {"ref": "application/production"},
            "head": {"sha": HEAD, "repo": {"full_name": preview.REPOSITORY}},
        }
        checks = [{"name": "Required PR gate", "id": 2, "head_sha": HEAD,
                   "app": {"slug": "github-actions"},
                   "status": "completed", "conclusion": "success"}]
        with patch.object(preview, "github", side_effect=[
            pr, {"check_runs": checks}, {"commit": {"sha": BASE}},
            comparison(status="diverged", behind_by=1),
        ]):
            with patch.dict("os.environ", {"PREVIEW_BACKEND_PR": "537"}):
                with self.assertRaises(ValueError):
                    preview.checked_pr("537", {"Required PR gate"})


if __name__ == "__main__":
    unittest.main()
