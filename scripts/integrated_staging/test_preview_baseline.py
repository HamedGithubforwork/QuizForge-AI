"""Fail closed if staging's reviewed feature branch lacks current app baseline."""
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.github_repository_identity import REPOSITORY_ID, SOURCE_OWNER_ID, SOURCE_REPOSITORY
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
    def test_read_only_preview_accepts_only_the_run_repository_identity(self):
        pr = {
            "state": "open",
            "base": {"ref": "application/production", "repo": {
                "full_name": SOURCE_REPOSITORY, "id": int(REPOSITORY_ID),
                "owner": {"id": int(SOURCE_OWNER_ID)},
            }},
            "head": {"sha": HEAD, "repo": {
                "full_name": SOURCE_REPOSITORY, "id": int(REPOSITORY_ID),
                "owner": {"id": int(SOURCE_OWNER_ID)},
            }},
        }
        checks = [{"name": "Required PR gate", "id": 2, "head_sha": HEAD,
                   "app": {"slug": "github-actions"},
                   "status": "completed", "conclusion": "success"}]
        self.assertEqual(preview.resolve(pr, checks, {"Required PR gate"}, SOURCE_REPOSITORY), HEAD)
        with self.assertRaises(ValueError):
            preview.resolve(pr, checks, {"Required PR gate"}, "attacker/QuizForge-AI")

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
            "base": {"ref": "application/production", "repo": {
                "full_name": SOURCE_REPOSITORY, "id": int(REPOSITORY_ID),
                "owner": {"id": int(SOURCE_OWNER_ID)},
            }},
            "head": {"sha": HEAD, "repo": {
                "full_name": SOURCE_REPOSITORY, "id": int(REPOSITORY_ID),
                "owner": {"id": int(SOURCE_OWNER_ID)},
            }},
        }
        checks = [{"name": "Required PR gate", "id": 2, "head_sha": HEAD,
                   "app": {"slug": "github-actions"},
                   "status": "completed", "conclusion": "success"}]
        with patch.object(preview, "github", side_effect=[
            pr, {"check_runs": checks}, {"commit": {"sha": BASE}},
            comparison(status="diverged", behind_by=1),
        ]):
            with patch.dict("os.environ", {
                "GITHUB_REPOSITORY": SOURCE_REPOSITORY,
                "GITHUB_REPOSITORY_ID": REPOSITORY_ID,
                "GITHUB_REPOSITORY_OWNER_ID": SOURCE_OWNER_ID,
                "PREVIEW_BACKEND_PR": "537",
            }):
                with self.assertRaises(ValueError):
                    preview.checked_pr("537", {"Required PR gate"}, SOURCE_REPOSITORY)

    def test_missing_or_closed_staging_pr_is_rejected_before_it_can_be_used(self):
        with patch.object(preview, "github") as github:
            with self.assertRaises(ValueError):
                preview.checked_pr("", {"Required PR gate"}, SOURCE_REPOSITORY)
            github.assert_not_called()

        pr = {
            "state": "closed",
            "base": {"ref": "application/production", "repo": {
                "full_name": SOURCE_REPOSITORY, "id": int(REPOSITORY_ID),
                "owner": {"id": int(SOURCE_OWNER_ID)},
            }},
            "head": {"sha": HEAD, "repo": {
                "full_name": SOURCE_REPOSITORY, "id": int(REPOSITORY_ID),
                "owner": {"id": int(SOURCE_OWNER_ID)},
            }},
        }
        with self.assertRaises(ValueError):
            preview.resolve(pr, [], {"Required PR gate"}, SOURCE_REPOSITORY)

    def test_wrong_base_repository_identity_is_rejected(self):
        pr = {
            "state": "open",
            "base": {"ref": "application/production", "repo": {
                "full_name": "attacker/QuizForge-AI", "id": int(REPOSITORY_ID),
                "owner": {"id": int(SOURCE_OWNER_ID)},
            }},
            "head": {"sha": HEAD, "repo": {
                "full_name": SOURCE_REPOSITORY, "id": int(REPOSITORY_ID),
                "owner": {"id": int(SOURCE_OWNER_ID)},
            }},
        }
        with self.assertRaises(ValueError):
            preview.resolve(pr, [], {"Required PR gate"}, SOURCE_REPOSITORY)

    def test_final_confirmation_rejects_changed_application_pr_head(self):
        pr = {
            "state": "open",
            "base": {"ref": "application/production", "repo": {
                "full_name": SOURCE_REPOSITORY, "id": int(REPOSITORY_ID),
                "owner": {"id": int(SOURCE_OWNER_ID)},
            }},
            "head": {"sha": HEAD, "repo": {
                "full_name": SOURCE_REPOSITORY, "id": int(REPOSITORY_ID),
                "owner": {"id": int(SOURCE_OWNER_ID)},
            }},
        }
        checks = [{"name": "Required PR gate", "id": 2, "head_sha": HEAD,
                   "app": {"slug": "github-actions"},
                   "status": "completed", "conclusion": "success"}]
        with patch.object(preview, "github", side_effect=[pr, {"check_runs": checks}]) as github:
            with self.assertRaisesRegex(ValueError, "head changed"):
                preview.checked_pr("537", {"Required PR gate"}, SOURCE_REPOSITORY, "c" * 40)
        self.assertEqual(github.call_count, 2)


if __name__ == "__main__":
    unittest.main()
