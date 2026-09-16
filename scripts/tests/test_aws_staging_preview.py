import copy
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aws_staging_preview import REPOSITORY, REQUIRED, resolve


class PreviewGuardTests(unittest.TestCase):
    def setUp(self):
        self.sha = "a" * 40
        self.pr = {"state": "open", "base": {"ref": "main"}, "head": {
            "sha": self.sha, "repo": {"full_name": REPOSITORY}}}
        self.checks = [{"id": i, "name": name, "head_sha": self.sha,
                        "app": {"slug": "github-actions"}, "status": "completed", "conclusion": "success"}
                       for i, name in enumerate(sorted(REQUIRED), 1)]

    def test_tested_same_repository_commit(self):
        self.assertEqual(resolve(self.pr, self.checks), self.sha)

    def test_forks_closed_prs_and_other_base_are_rejected(self):
        for field in ("fork", "closed", "base"):
            pr = copy.deepcopy(self.pr)
            if field == "fork": pr["head"]["repo"]["full_name"] = "other/repo"
            if field == "closed": pr["state"] = "closed"
            if field == "base": pr["base"]["ref"] = "other"
            with self.assertRaises(ValueError): resolve(pr, self.checks)

    def test_stale_failed_or_missing_checks_cannot_authorize(self):
        for field, value in (("head_sha", "b" * 40), ("conclusion", "failure"),
                             ("status", "in_progress"), ("app", {"slug": "other"})):
            checks = copy.deepcopy(self.checks)
            checks[0][field] = value
            with self.assertRaises(ValueError): resolve(self.pr, checks)
        with self.assertRaises(ValueError): resolve(self.pr, self.checks[1:])

    def test_latest_rerun_must_pass(self):
        check = {**self.checks[0], "id": 100, "conclusion": None, "status": "in_progress"}
        with self.assertRaises(ValueError): resolve(self.pr, self.checks + [check])


if __name__ == "__main__": unittest.main()
