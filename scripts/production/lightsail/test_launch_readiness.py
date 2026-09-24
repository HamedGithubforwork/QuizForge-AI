from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.production.lightsail.launch_readiness import (
    API_DOMAIN,
    DOMAIN,
    REMOTE_CHECK,
    evaluate_dns,
    write_report,
)


class LaunchReadinessTests(unittest.TestCase):
    def test_remote_check_is_read_only_and_requires_inactive_ai_disabled_shape(self):
        self.assertIn("/var/lib/quizforge/base-host-ready", REMOTE_CHECK)
        self.assertIn("/etc/quizforge/database-initialized", REMOTE_CHECK)
        self.assertIn("test ! -e /etc/quizforge/launch-approved", REMOTE_CHECK)
        self.assertIn("! systemctl is-active --quiet quizforge.service", REMOTE_CHECK)
        self.assertIn("! systemctl is-enabled --quiet quizforge.service", REMOTE_CHECK)
        self.assertIn("disabled-until-explicit-activation-", REMOTE_CHECK)
        self.assertIn("docker compose -f", REMOTE_CHECK)
        self.assertIn("ps --status running", REMOTE_CHECK)
        self.assertNotIn("touch /etc/quizforge/launch-approved", REMOTE_CHECK)
        self.assertNotIn("systemctl start quizforge", REMOTE_CHECK)
        self.assertNotIn("systemctl enable quizforge", REMOTE_CHECK)
        self.assertNotIn("route53", REMOTE_CHECK.lower())

    def test_dns_evaluation_distinguishes_cutover_from_already_pointing(self):
        ip = "198.51.100.20"
        ns = ["ns-1.example.net", "ns-2.example.net", "ns-3.example.net", "ns-4.example.net"]
        empty = evaluate_dns([], ip, ns, ns, [], [])
        self.assertTrue(empty["public_delegation_matches_route53"])
        self.assertTrue(empty["dns_cutover_required"])
        self.assertFalse(empty["route53_apex_points_to_lightsail"])

        records = [
            {"Name": DOMAIN + ".", "Type": "A", "ResourceRecords": [{"Value": ip}]},
            {"Name": API_DOMAIN + ".", "Type": "A", "ResourceRecords": [{"Value": ip}]},
        ]
        ready = evaluate_dns(records, ip, ns, ns, [ip], [ip])
        self.assertFalse(ready["dns_cutover_required"])
        self.assertTrue(ready["route53_apex_points_to_lightsail"])
        self.assertTrue(ready["route53_api_points_to_lightsail"])
        self.assertTrue(ready["public_apex_points_to_lightsail"])
        self.assertTrue(ready["public_api_points_to_lightsail"])

    def test_public_summary_rejects_ip_and_private_values(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "summary.json"
            with patch("scripts.production.lightsail.launch_readiness.RESULT", target):
                with self.assertRaises(ValueError):
                    write_report({"unsafe": "198.51.100.20"}, [])
                with self.assertRaises(ValueError):
                    write_report({"unsafe": "private-material"}, ["private-material"])
                write_report(
                    {
                        "result": "launch_readiness_passed_dns_cutover_required",
                        "public_launch_attempted": False,
                        "dns_changes_performed": False,
                        "ai_enabled": False,
                    },
                    [],
                )
                value = json.loads(target.read_text())
                self.assertFalse(value["public_launch_attempted"])
                self.assertFalse(value["dns_changes_performed"])
                self.assertFalse(value["ai_enabled"])


if __name__ == "__main__":
    unittest.main()
