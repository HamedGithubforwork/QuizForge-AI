from pathlib import Path
import unittest

from scripts.production.lightsail.host_control import (
    baseline_ports,
    normalized_ports,
    scp_command,
    ssh_command,
)


class HostControlTests(unittest.TestCase):
    def test_exact_baseline_firewall_normalizes(self):
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
        self.assertEqual(normalized_ports(ports), baseline_ports(admin))

    def test_ssh_and_scp_require_pinned_known_hosts(self):
        key = Path("/tmp/identity")
        cert = Path("/tmp/identity-cert.pub")
        known = Path("/tmp/known_hosts")

        ssh = ssh_command(
            key,
            cert,
            known,
            "ubuntu",
            "198.51.100.20",
            "true",
        )
        scp = scp_command(
            key,
            cert,
            known,
            "ubuntu",
            "198.51.100.20",
            Path("/tmp/bundle.tgz"),
            "/home/ubuntu/bundle.tgz",
        )

        for command in (ssh, scp):
            joined = " ".join(map(str, command))
            self.assertIn("StrictHostKeyChecking=yes", joined)
            self.assertIn("IdentitiesOnly=yes", joined)
            self.assertIn("BatchMode=yes", joined)
            self.assertIn("UserKnownHostsFile=/tmp/known_hosts", joined)
            self.assertIn("CertificateFile=/tmp/identity-cert.pub", joined)

        self.assertEqual(ssh[-2:], ["ubuntu@198.51.100.20", "true"])
        self.assertEqual(
            scp[-2:],
            [
                "/tmp/bundle.tgz",
                "ubuntu@198.51.100.20:/home/ubuntu/bundle.tgz",
            ],
        )


if __name__ == "__main__":
    unittest.main()
