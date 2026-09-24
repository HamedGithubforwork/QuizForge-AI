from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.production.lightsail.ssh_trust_probe import (
    baseline_expected,
    parse_keyscan,
    write_report,
)


class SSHTrustProbeTests(unittest.TestCase):
    def test_parse_keyscan_returns_only_safe_fingerprints(self):
        # Base64 for synthetic key bytes, not a real host key.
        line = "198.51.100.20 ssh-ed25519 c3ludGhldGljLWtleS1ieXRlcw=="
        result = parse_keyscan(line, "198.51.100.20")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["algorithm"], "ssh-ed25519")
        self.assertTrue(result[0]["fingerprint_sha256"].startswith("SHA256:"))
        raw = json.dumps(result)
        self.assertNotIn("198.51.100.20", raw)
        self.assertNotIn("c3ludGhldGljLWtleS1ieXRlcw==", raw)

    def test_baseline_requires_exact_firewall(self):
        admin = "192.0.2.10/32"
        ports = [
            {
                "fromPort": 22,
                "toPort": 22,
                "protocol": "tcp",
                "cidrs": [admin],
                "ipv6Cidrs": [],
                "cidrListAliases": [],
            },
            {
                "fromPort": 80,
                "toPort": 80,
                "protocol": "tcp",
                "cidrs": ["0.0.0.0/0"],
                "ipv6Cidrs": [],
                "cidrListAliases": [],
            },
            {
                "fromPort": 443,
                "toPort": 443,
                "protocol": "tcp",
                "cidrs": ["0.0.0.0/0"],
                "ipv6Cidrs": [],
                "cidrListAliases": [],
            },
        ]
        self.assertTrue(baseline_expected(ports, admin))
        ports[0]["cidrs"] = ["0.0.0.0/0"]
        self.assertFalse(baseline_expected(ports, admin))

    def test_public_summary_refuses_ipv4_values(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "summary.json"
            with patch(
                "scripts.production.lightsail.ssh_trust_probe.RESULT",
                target,
            ):
                with self.assertRaises(ValueError):
                    write_report({"unsafe": "198.51.100.20"})
                write_report({
                    "result": "ok",
                    "host_keys": [{
                        "algorithm": "ssh-ed25519",
                        "fingerprint_sha256": "SHA256:synthetic",
                    }],
                })
                self.assertTrue(target.is_file())


if __name__ == "__main__":
    unittest.main()
