"""Fail-closed, no-AWS tests for the one-time PR #538 staging publication."""
import unittest

from auto_frontend_merge import (
    CHANGES, FRONTEND_PR, FRONTEND_SHA, MARKER, REPOSITORY, REQUEST,
    TRIGGER_BRANCH, authorize,
)

BEFORE = "a" * 40
AFTER = "b" * 40


def event():
    return {"before": BEFORE, "after": AFTER, "ref": "refs/heads/main",
            "repository": {"full_name": REPOSITORY}}


def merged():
    return [{"merged_at": "2026-10-12T22:40:00Z", "merge_commit_sha": AFTER,
             "base": {"ref": "main"}, "head": {
                 "ref": TRIGGER_BRANCH, "repo": {"full_name": REPOSITORY},
             }}]


class OneTimeStagingPublication(unittest.TestCase):
    def test_pins_only_approved_frontend_pr_and_commit(self):
        self.assertEqual(FRONTEND_PR, "538")
        self.assertEqual(FRONTEND_SHA, "af9393ac74301f1e298b11f83a32a620bd7fdac3")
        self.assertEqual(REQUEST["operation"], "frontend")
        self.assertEqual(REQUEST["environment"], "quizforge-integrated-staging")
        self.assertEqual(REQUEST["frontend_sha"], FRONTEND_SHA)

    def test_authorizes_only_exact_reviewed_main_merge(self):
        self.assertTrue(authorize(event(), sorted(CHANGES), merged(), REQUEST))

    def test_rejects_any_extra_or_missing_file_or_marker_replay(self):
        for changed in (
            [], sorted(CHANGES - {f"A\t{MARKER}"}),
            sorted(CHANGES | {"A\tfrontend/src/App.tsx"}),
            sorted(CHANGES - {f"A\t{MARKER}"} | {f"M\t{MARKER}"}),
            sorted(CHANGES - {"M\te2e/staging-live-auth-smoke.mjs"}),
        ):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                authorize(event(), changed, merged(), REQUEST)

    def test_rejects_bad_repo_branch_commit_and_nonmerge(self):
        for key, bad in (("ref", "refs/heads/develop"), ("before", "0" * 40),
                         ("after", "bad"), ("before", AFTER)):
            item = event()
            item[key] = bad
            with self.subTest(key=key), self.assertRaises(ValueError):
                authorize(item, sorted(CHANGES), merged(), REQUEST)
        item = event()
        item["repository"] = {"full_name": "outsider/other"}
        with self.assertRaises(ValueError):
            authorize(item, sorted(CHANGES), merged(), REQUEST)
        for key, bad in (("merged_at", None), ("merge_commit_sha", "c" * 40),
                         ("base", {"ref": "application/production"}),
                         ("head", {"ref": "other", "repo": {"full_name": REPOSITORY}})):
            prs = merged()
            prs[0][key] = bad
            with self.subTest(key=key), self.assertRaises(ValueError):
                authorize(event(), sorted(CHANGES), prs, REQUEST)

    def test_rejects_request_tampering_and_credentialed_production(self):
        for key, bad in (("operation", "align_recovery_hook"),
                         ("frontend_pr", 999), ("frontend_sha", "a" * 40),
                         ("environment", "production"), ("mode", "replay-anytime"),
                         ("extra", "anything")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                authorize(event(), sorted(CHANGES), merged(), {**REQUEST, key: bad})


if __name__ == "__main__":
    unittest.main()
