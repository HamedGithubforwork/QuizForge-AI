"""No-cloud negative and regression tests for manual staging AI budget actions."""
import unittest
from ai_budget import (
    ALLOWED, RESULT, SCRIPT, STAGING_CAP, TASK_FAMILY, command_for, parse_status,
    require_trusted_manual_action,
)


def env(action="status"):
    return {
        "STAGING_AI_BUDGET_ACTION": action,
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_REPOSITORY": "HamedGithubforwork/QuizForge-AI",
    }


class StagingBudgetSafety(unittest.TestCase):
    def test_real_ecs_task_definition_arn_syntax(self):
        # ECS task-definition ARNs contain a slash after task-definition.
        valid = (
            "arn:aws:ecs:ca-central-1:123456789012:"
            "task-definition/quizforge-integrated-staging-probe:15"
        )
        self.assertIsNotNone(TASK_FAMILY.fullmatch(valid))
        for bad in (
            valid.replace("task-definition/", "task-definition:"),
            valid.replace("quizforge-integrated-staging-probe", "quizforge-integrated-staging-api"),
            valid.replace("ca-central-1", "us-east-1"),
            valid.replace(":15", ":x"),
        ):
            with self.subTest(arn=bad):
                self.assertIsNone(TASK_FAMILY.fullmatch(bad))

    def test_exact_main_only_manual_operations(self):
        for action in ALLOWED:
            self.assertIsNone(require_trusted_manual_action(action, env(action)))
            for key, replacement in (
                ("GITHUB_EVENT_NAME", "pull_request"),
                ("GITHUB_REF", "refs/heads/application/production"),
                ("GITHUB_REPOSITORY", "someone/other"),
                ("STAGING_AI_BUDGET_ACTION", "refill" if action == "status" else "status"),
            ):
                with self.subTest(action=action, key=key), self.assertRaises(ValueError):
                    require_trusted_manual_action(
                        action, {**env(action), key: replacement}
                    )
        for bad in ("set", "11", "reset", "", "refill; echo secret"):
            with self.subTest(action=bad), self.assertRaises(ValueError):
                require_trusted_manual_action(bad, env(bad))
            with self.assertRaises(ValueError):
                command_for(bad)

    def test_inline_script_is_staging_specific_and_atomic(self):
        self.assertEqual(STAGING_CAP, 10)
        self.assertEqual(command_for("status"), ["python", "-c", SCRIPT, "status"])
        self.assertEqual(command_for("refill"), ["python", "-c", SCRIPT, "refill"])
        self.assertIn("integration:openai:remaining", SCRIPT)
        self.assertIn("integration:openai:calls", SCRIPT)
        self.assertIn("redis.call('SET', KEYS[1], 10)", SCRIPT)
        self.assertIn("redis.call('TTL', KEYS[1]) ~= -1", SCRIPT)
        self.assertIn('url.startswith("rediss://")', SCRIPT)
        self.assertNotIn("OPENAI_API_KEY", SCRIPT)
        self.assertNotIn("PGPASSWORD", SCRIPT)
        self.assertNotIn("get_secret_value", SCRIPT)
        compile(SCRIPT, "staging_budget_inline", "exec")

    def test_numeric_receipts_only_and_fail_closed(self):
        expected = "STAGING_AI_BUDGET remaining=9 total_calls=1 allowance=10"
        self.assertIsNotNone(RESULT.fullmatch(expected))
        self.assertEqual(parse_status([{"message": expected}]), (9, 1))
        for entries in (
            [], [{"message": expected}, {"message": expected}],
            [{"message": "STAGING_AI_BUDGET remaining=11 total_calls=0 allowance=10"}],
            [{"message": "STAGING_AI_BUDGET remaining=9 total_calls=-1 allowance=10"}],
            [{"message": "token=secret"}],
        ):
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                parse_status(entries)


if __name__ == "__main__":
    unittest.main()
