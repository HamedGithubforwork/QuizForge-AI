from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.production.lightsail.public_launch import (
    API_DOMAIN,
    DOMAIN,
    REMOTE_COMMIT,
    REMOTE_PRELAUNCH,
    REMOTE_ROLLBACK,
    PUBLIC_RESOLVERS,
    cutover_changes,
    desired_record,
    relevant_records,
    restore_changes,
    root_bash_command,
    write_report,
)


class PublicLaunchTests(unittest.TestCase):
    def test_cutover_only_changes_apex_and_api_traffic_records(self):
        old = [
            {"Name": DOMAIN + ".", "Type": "A", "TTL": 300, "ResourceRecords": [{"Value": "192.0.2.10"}]},
            {"Name": API_DOMAIN + ".", "Type": "CNAME", "TTL": 300, "ResourceRecords": [{"Value": "legacy.example.net."}]},
            {"Name": DOMAIN + ".", "Type": "MX", "TTL": 300, "ResourceRecords": [{"Value": "10 mail.example.net."}]},
            {"Name": "_verify." + DOMAIN + ".", "Type": "TXT", "TTL": 300, "ResourceRecords": [{"Value": "\"keep\""}]},
        ]
        relevant = relevant_records(old)
        self.assertEqual(len(relevant), 2)
        changes = cutover_changes(relevant, "198.51.100.20")
        self.assertEqual([c["Action"] for c in changes], ["DELETE", "CREATE", "DELETE", "CREATE"])
        creates = [c["ResourceRecordSet"] for c in changes if c["Action"] == "CREATE"]
        self.assertEqual({r["Name"] for r in creates}, {DOMAIN + ".", API_DOMAIN + "."})
        self.assertTrue(all(r["Type"] == "A" for r in creates))

    def test_cutover_is_noop_when_both_names_already_point_to_target(self):
        ip = "198.51.100.20"
        original = [desired_record(DOMAIN, ip), desired_record(API_DOMAIN, ip)]
        self.assertEqual(cutover_changes(original, ip), [])

    def test_restore_replaces_cutover_records_with_original_records(self):
        ip = "198.51.100.20"
        current = [desired_record(DOMAIN, ip), desired_record(API_DOMAIN, ip)]
        original = [
            {"Name": DOMAIN + ".", "Type": "A", "TTL": 300, "ResourceRecords": [{"Value": "192.0.2.10"}]},
            {"Name": API_DOMAIN + ".", "Type": "CNAME", "TTL": 300, "ResourceRecords": [{"Value": "legacy.example.net."}]},
        ]
        changes = restore_changes(current, original)
        self.assertEqual([c["Action"] for c in changes], ["DELETE", "DELETE", "CREATE", "CREATE"])

    def test_remote_launch_phases_startup_keeps_ai_disabled_and_has_explicit_rollback(self):
        self.assertIn("disabled-until-explicit-activation-", REMOTE_PRELAUNCH)
        self.assertIn("wait_health()", REMOTE_PRELAUNCH)
        self.assertIn("up -d --pull never db redis", REMOTE_PRELAUNCH)
        self.assertIn("wait_health db 90", REMOTE_PRELAUNCH)
        self.assertIn("wait_health redis 90", REMOTE_PRELAUNCH)
        self.assertIn("up -d --pull never api identity guard", REMOTE_PRELAUNCH)
        self.assertIn("wait_health api 90", REMOTE_PRELAUNCH)
        self.assertIn("wait_health identity 90", REMOTE_PRELAUNCH)
        self.assertIn("up -d --pull never web", REMOTE_PRELAUNCH)
        self.assertNotIn("--wait --wait-timeout", REMOTE_PRELAUNCH)
        self.assertIn("test ! -e /etc/quizforge/launch-approved", REMOTE_PRELAUNCH)
        self.assertNotIn("tee /etc/quizforge/launch-approved", REMOTE_PRELAUNCH)
        self.assertNotIn("touch /etc/quizforge/launch-approved", REMOTE_PRELAUNCH)
        self.assertIn("systemctl enable quizforge.service", REMOTE_COMMIT)
        self.assertIn("systemctl start quizforge.service", REMOTE_COMMIT)
        self.assertIn("systemctl stop quizforge.service", REMOTE_ROLLBACK)
        self.assertIn("systemctl disable quizforge.service", REMOTE_ROLLBACK)
        self.assertIn("rm -f /etc/quizforge/launch-approved", REMOTE_ROLLBACK)
        self.assertIn("! grep -q '^OPENAI_API_KEY=sk-'", REMOTE_PRELAUNCH)
        self.assertIn("! grep -q '^OPENAI_API_KEY=sk-'", REMOTE_COMMIT)
        self.assertNotIn("tee /etc/quizforge/generation.env", REMOTE_PRELAUNCH + REMOTE_COMMIT)
        self.assertNotIn("enabled=true", REMOTE_PRELAUNCH + REMOTE_COMMIT)
        self.assertEqual(PUBLIC_RESOLVERS, ("1.1.1.1", "8.8.8.8"))

    def test_launch_remote_scripts_run_under_noninteractive_root_shell(self):
        command = root_bash_command(
            Path("/tmp/key"),
            Path("/tmp/cert"),
            Path("/tmp/known"),
            "ubuntu",
            "198.51.100.20",
            "--",
            "a" * 40,
        )
        self.assertEqual(command[-5:], ["sudo", "bash", "-s", "--", "a" * 40])

    def test_public_summary_rejects_ip_and_private_values(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "summary.json"
            with patch("scripts.production.lightsail.public_launch.RESULT", target):
                with self.assertRaises(ValueError):
                    write_report({"unsafe": "198.51.100.20"}, [])
                with self.assertRaises(ValueError):
                    write_report({"unsafe": "private-material"}, ["private-material"])
                write_report(
                    {
                        "result": "public_launch_verified_ai_disabled",
                        "public_https_verified": True,
                        "ai_enabled": False,
                    },
                    [],
                )
                value = json.loads(target.read_text())
                self.assertTrue(value["public_https_verified"])
                self.assertFalse(value["ai_enabled"])


if __name__ == "__main__":
    unittest.main()
