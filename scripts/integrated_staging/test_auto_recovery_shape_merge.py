"""One-time staging diagnostic cannot run on other pushes."""
import unittest
from auto_recovery_shape_merge import MARKER, PR, REQUEST, authorize
from auto_parity_merge import REPOSITORY

BEFORE = "a"*40
AFTER = "b"*40


def event():
    return {"before": BEFORE, "after": AFTER, "ref": "refs/heads/main",
            "repository": {"full_name": REPOSITORY}}


def merged():
    return [{"number": PR, "merged_at": "2026-10-12T18:30:00Z",
             "merge_commit_sha": AFTER, "base": {"ref": "main"},
             "head": {"repo": {"full_name": REPOSITORY}}}]


class StrictDiagnosticGate(unittest.TestCase):
    def test_one_exact_reviewed_request(self):
        self.assertTrue(authorize(event(), [f"A\t{MARKER}"], merged(), REQUEST))

    def test_refuses_wrong_commit_ref_or_repository(self):
        for field, bad in (("after", "c"*40), ("before", "0"*40),
                           ("ref", "refs/heads/feature")):
            e = event()
            e[field] = bad
            with self.subTest(field=field), self.assertRaises(ValueError):
                authorize(e, [f"A\t{MARKER}"], merged(), REQUEST)
        e = event()
        e["repository"]["full_name"] = "someone/else"
        with self.assertRaises(ValueError):
            authorize(e, [f"A\t{MARKER}"], merged(), REQUEST)

    def test_refuses_unreviewed_or_reused_marker(self):
        for changes in ([], [f"M\t{MARKER}"], [f"D\t{MARKER}"], ["A\tother"]):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                authorize(event(), changes, merged(), REQUEST)
        for key, value in (("operation", "align_recovery_hook"),
                           ("mode", "write"), ("pull_request", 563),
                           ("environment", "production-lightsail")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                authorize(event(), [f"A\t{MARKER}"], merged(), {**REQUEST, key:value})
        other = merged()
        other[0]["number"] = 564
        with self.assertRaises(ValueError):
            authorize(event(), [f"A\t{MARKER}"], other, REQUEST)


if __name__ == "__main__":
    unittest.main()
