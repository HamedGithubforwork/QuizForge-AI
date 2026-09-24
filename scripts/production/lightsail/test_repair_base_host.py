from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.production.lightsail.repair_base_host import (
    REMOTE_REPAIR,
    write_report,
)


class BaseHostRepairTests(unittest.TestCase):
    def test_remote_repair_is_base_host_only(self):
        self.assertIn("apt-get update -qq", REMOTE_REPAIR)
        self.assertIn("docker.io docker-compose-v2 unattended-upgrades", REMOTE_REPAIR)
        self.assertIn("systemctl enable --now docker", REMOTE_REPAIR)
        self.assertIn("/var/lib/quizforge/base-host-ready", REMOTE_REPAIR)
        self.assertNotIn("touch /etc/quizforge/launch-approved", REMOTE_REPAIR)
        self.assertNotIn("systemctl start quizforge", REMOTE_REPAIR)
        self.assertNotIn("systemctl enable quizforge", REMOTE_REPAIR)
        self.assertNotIn("route53", REMOTE_REPAIR.lower())
        self.assertNotIn("openai", REMOTE_REPAIR.lower())

    def test_public_summary_rejects_ip_and_private_values(self):
        with tempfile.TemporaryDirectory() as root:
            target=Path(root)/"summary.json"
            with patch("scripts.production.lightsail.repair_base_host.RESULT",target):
                with self.assertRaises(ValueError):
                    write_report({"unsafe":"198.51.100.20"},[])
                with self.assertRaises(ValueError):
                    write_report({"unsafe":"secret-value"},["secret-value"])
                write_report(
                    {
                        "result":"base_host_repaired_application_inactive",
                        "application_launch_attempted":False,
                    },
                    [],
                )
                value=json.loads(target.read_text())
                self.assertFalse(value["application_launch_attempted"])


if __name__=="__main__":
    unittest.main()
