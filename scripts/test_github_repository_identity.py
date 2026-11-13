import re
import unittest
from pathlib import Path

from scripts.github_repository_identity import (
    OWNER_ID,
    REPOSITORY,
    REPOSITORY_ID,
    is_target_actions_environment,
    is_target_repository,
    is_target_repository_object,
)


class GitHubRepositoryIdentityTests(unittest.TestCase):
    def test_trust_anchor_is_the_reviewed_destination_identity(self):
        self.assertEqual(REPOSITORY, "QuizFromNotes/QuizForge-AI")
        self.assertEqual(REPOSITORY_ID, "1307099196")
        self.assertEqual(OWNER_ID, "356387243")

    def test_exact_destination_name_and_ids_are_accepted(self):
        self.assertTrue(is_target_repository(REPOSITORY, REPOSITORY_ID, OWNER_ID))
        self.assertTrue(is_target_actions_environment({
            "GITHUB_REPOSITORY": REPOSITORY,
            "GITHUB_REPOSITORY_ID": REPOSITORY_ID,
            "GITHUB_REPOSITORY_OWNER_ID": OWNER_ID,
        }))

    def test_old_source_identity_is_rejected(self):
        self.assertFalse(is_target_repository(
            "HamedGithubforwork/QuizForge-AI", REPOSITORY_ID, "148009407"
        ))
        self.assertFalse(is_target_actions_environment({
            "GITHUB_REPOSITORY": "HamedGithubforwork/QuizForge-AI",
            "GITHUB_REPOSITORY_ID": REPOSITORY_ID,
            "GITHUB_REPOSITORY_OWNER_ID": "148009407",
        }))

    def test_wrong_or_missing_repository_and_owner_ids_are_rejected(self):
        for repository, repository_id, owner_id in (
            (REPOSITORY, "999", OWNER_ID),
            (REPOSITORY, REPOSITORY_ID, "999"),
            (REPOSITORY, None, OWNER_ID),
            (REPOSITORY, REPOSITORY_ID, None),
            ("other/QuizForge-AI", REPOSITORY_ID, OWNER_ID),
        ):
            with self.subTest(repository=repository, repository_id=repository_id, owner_id=owner_id):
                self.assertFalse(is_target_repository(repository, repository_id, owner_id))

    def test_github_repository_objects_require_both_ids_and_destination_name(self):
        target = {"full_name": REPOSITORY, "id": int(REPOSITORY_ID),
                  "owner": {"id": int(OWNER_ID)}}
        self.assertTrue(is_target_repository_object(target))
        for invalid in (
            {**target, "full_name": "HamedGithubforwork/QuizForge-AI"},
            {**target, "id": 7},
            {**target, "owner": {"id": 7}},
            {"full_name": REPOSITORY},
        ):
            with self.subTest(invalid=invalid):
                self.assertFalse(is_target_repository_object(invalid))

    def test_workflow_identity_guards_require_destination_name_and_both_ids(self):
        root = Path(__file__).resolve().parents[1]
        workflows = root / ".github" / "workflows"
        guard_count = 0
        for path in workflows.glob("*.yml"):
            content = path.read_text(encoding="utf-8")
            self.assertNotIn("github.repository == 'HamedGithubforwork/QuizForge-AI'", content, path.name)
            if "github.repository == 'QuizFromNotes/QuizForge-AI'" in content:
                guard_count += 1
                self.assertIn("github.repository_id == '1307099196'", content, path.name)
                self.assertIn("github.repository_owner_id == '356387243'", content, path.name)
        self.assertEqual(guard_count, 19)

    def test_local_ai_contract_checkouts_follow_current_repository_without_enabling_model_runs(self):
        root = Path(__file__).resolve().parents[1]
        workflows = root / ".github" / "workflows"
        for version in ("v3", "v4"):
            content = (workflows / f"local-ai-prompt-{version}.yml").read_text(encoding="utf-8")
            self.assertEqual(content.count("repository: ${{ github.repository }}"), 2)
            self.assertRegex(content, r"(?s)compare:\s+name:.*?if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}")
            self.assertEqual(len(re.findall(r"(?m)^\s+ref: ([a-f0-9]{40})$", content)), 2)


if __name__ == "__main__":
    unittest.main()
