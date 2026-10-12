"""No-cloud checks for a review-gated staging merge trigger."""
import unittest
from auto_parity_merge import MARKER, REPOSITORY, PR_NUMBER, REQUEST, authorize

BEFORE = "a" * 40
AFTER = "b" * 40


def event():
    return {"before": BEFORE, "after": AFTER, "ref": "refs/heads/main",
            "repository": {"full_name": REPOSITORY}}


def merged():
    return [{"number": PR_NUMBER, "merged_at": "2026-10-12T16:30:00Z",
             "merge_commit_sha": AFTER, "base": {"ref": "main"},
             "head": {"repo": {"full_name": REPOSITORY}}}]


class AuthorizedStagingMerge(unittest.TestCase):
    def test_valid_reviewed_merge(self):
        self.assertTrue(authorize(event(), [f"A\t{MARKER}"], merged(), REQUEST))

    def test_wrong_branch_repo_or_sha_fails(self):
        for field, bad in (("ref", "refs/heads/feature"), ("before", "0" * 40),
                           ("after", "bad"), ("before", AFTER)):
            e = event()
            e[field] = bad
            with self.subTest(field=field), self.assertRaises(ValueError):
                authorize(e, [f"A\t{MARKER}"], merged(), REQUEST)
        e = event()
        e["repository"] = {"full_name": "untrusted/fork"}
        with self.assertRaises(ValueError):
            authorize(e, [f"A\t{MARKER}"], merged(), REQUEST)

    def test_marker_must_be_new_not_changed(self):
        for changes in ([], [f"M\t{MARKER}"], [f"D\t{MARKER}"], ["A\tother"]):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                authorize(event(), changes, merged(), REQUEST)

    def test_requires_exact_trusted_merged_pr(self):
        for field, bad in (("number", 999), ("merged_at", None),
                           ("merge_commit_sha", "c" * 40)):
            prs = merged()
            prs[0][field] = bad
            with self.subTest(field=field), self.assertRaises(ValueError):
                authorize(event(), [f"A\t{MARKER}"], prs, REQUEST)
        for field, bad in (("base", {"ref": "other"}),
                           ("head", {"repo": {"full_name": "untrusted/fork"}})):
            prs = merged()
            prs[0][field] = bad
            with self.subTest(field=field), self.assertRaises(ValueError):
                authorize(event(), [f"A\t{MARKER}"], prs, REQUEST)

    def test_unapproved_operation_and_extra_fields_fail(self):
        for field, bad in (("operation", "frontend"), ("pull_request", 564),
                           ("environment", "production-lightsail"),
                           ("mode", "unbounded"), ("extra", True)):
            with self.subTest(field=field), self.assertRaises(ValueError):
                authorize(event(), [f"A\t{MARKER}"], merged(), {**REQUEST, field: bad})


if __name__ == "__main__":
    unittest.main()
