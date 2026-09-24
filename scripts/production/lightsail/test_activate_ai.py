from __future__ import annotations
import unittest

from scripts.production.generation_costs import APPROVED_MONTHLY_NANO_USD
from scripts.production.lightsail.activate_ai import (
    CANARY_MAX_OUTPUT_TOKENS,
    DAILY_REQUESTS,
    MONTHLY_REQUESTS,
    REMOTE_ACTIVATE,
    REMOTE_DISABLE,
)

class ActivateAITests(unittest.TestCase):
    def test_activation_uses_exact_approved_budget_and_bounded_counts(self):
        self.assertEqual(APPROVED_MONTHLY_NANO_USD, 5_000_000_000)
        self.assertEqual(DAILY_REQUESTS, 100)
        self.assertEqual(MONTHLY_REQUESTS, 1000)
        self.assertEqual(CANARY_MAX_OUTPUT_TOKENS, 64)
        self.assertIn("monthly_nano_usd=%s", REMOTE_ACTIVATE)
        self.assertIn("enabled=true", REMOTE_ACTIVATE)
        self.assertIn("daily_requests=%s", REMOTE_ACTIVATE)
        self.assertIn("monthly_requests=%s", REMOTE_ACTIVATE)

    def test_live_key_is_not_embedded_and_one_synthetic_canary_is_bounded(self):
        self.assertIn("/etc/quizforge/openai-api-key.pending", REMOTE_ACTIVATE)
        self.assertIn("Return only the word READY", REMOTE_ACTIVATE)
        self.assertIn('"max_output_tokens":tokens', REMOTE_ACTIVATE)
        self.assertNotIn("sk-", REMOTE_ACTIVATE)
        self.assertNotIn("user notes", REMOTE_ACTIVATE.lower())

    def test_failure_path_disables_policy_and_replaces_key(self):
        self.assertIn("SET enabled=false,daily_requests=0,monthly_requests=0", REMOTE_DISABLE)
        self.assertIn("disabled-until-explicit-activation-", REMOTE_DISABLE)
        self.assertIn("--force-recreate --no-deps guard", REMOTE_DISABLE)

if __name__=="__main__":
    unittest.main()
