from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.production.lightsail.initialize_runtime import REMOTE_INIT, write_report


class RuntimeInitializeTests(unittest.TestCase):
    def test_remote_initialization_stays_private_and_ai_disabled(self):
        self.assertIn("/etc/quizforge/database-initialized", REMOTE_INIT)
        self.assertIn("reviewed-ai-policy.sql", REMOTE_INIT)
        self.assertIn('"enabled"] is False', REMOTE_INIT)
        self.assertIn('"daily_requests"]==0', REMOTE_INIT)
        self.assertIn('"monthly_requests"]==0', REMOTE_INIT)
        self.assertIn("disabled-until-explicit-activation-", REMOTE_INIT)
        self.assertIn("docker compose -f", REMOTE_INIT)
        self.assertIn("stop --timeout 30 guard api identity db redis", REMOTE_INIT)
        self.assertNotIn("touch /etc/quizforge/launch-approved", REMOTE_INIT)
        self.assertNotIn("systemctl start quizforge", REMOTE_INIT)
        self.assertNotIn("systemctl enable quizforge", REMOTE_INIT)
        self.assertNotIn("api.openai.com", REMOTE_INIT)
        self.assertNotIn("route53", REMOTE_INIT.lower())

    def test_tls_signing_key_is_temporary_only(self):
        self.assertIn('keyout "$work/ca.key"', REMOTE_INIT)
        self.assertIn('rm -rf "$work"', REMOTE_INIT)
        self.assertNotIn("/etc/quizforge/postgres/ca.key", REMOTE_INIT)
        self.assertIn("DNS:db.quizforge.internal", REMOTE_INIT)

    def test_public_summary_rejects_ip_and_private_values(self):
        with tempfile.TemporaryDirectory() as root:
            target=Path(root)/"summary.json"
            with patch("scripts.production.lightsail.initialize_runtime.RESULT",target):
                with self.assertRaises(ValueError):
                    write_report({"unsafe":"198.51.100.20"},[])
                with self.assertRaises(ValueError):
                    write_report({"unsafe":"secret-value"},["secret-value"])
                write_report(
                    {
                        "result":"runtime_initialized_local_acceptance_passed_services_stopped",
                        "ai_enabled":False,
                        "public_launch_attempted":False,
                    },
                    [],
                )
                value=json.loads(target.read_text())
                self.assertFalse(value["ai_enabled"])
                self.assertFalse(value["public_launch_attempted"])


if __name__=="__main__":
    unittest.main()
