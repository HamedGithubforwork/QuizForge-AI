from __future__ import annotations

import json
import unittest

from scripts.production.lightsail.deploy_readiness import (
    REMOTE_SCRIPT,
    access_shape,
    deploy_prerequisites,
    known_hosts_text,
    validate_remote,
    version_tuple,
)


class DeployReadinessTests(unittest.TestCase):
    def remote(self):
        return {
            "base_host_ready": True,
            "ubuntu_24_04": True,
            "sudo_noninteractive": True,
            "docker_active": True,
            "docker_server_version": "27.5.1",
            "compose_version": "2.33.1",
            "cgroup_v2": True,
            "swap_disabled": True,
            "etc_quizforge_mode_0700": True,
            "var_lib_quizforge_mode_0700": True,
            "current_release_present": False,
            "launch_marker_present": False,
            "quizforge_service_active": False,
            "quizforge_service_file_present": False,
            "disk_free_gib": 53,
            "disk_total_gib": 57,
            "ssh_password_auth_disabled": True,
            "ssh_root_login_disabled": True,
            "ssh_tcp_forwarding_disabled": True,
        }

    def test_root_only_ready_marker_is_checked_with_sudo(self):
        self.assertIn(
            'run("sudo", "-n", "test", "-f", "/var/lib/quizforge/base-host-ready")',
            REMOTE_SCRIPT,
        )
        self.assertNotIn(
            'os.path.isfile("/var/lib/quizforge/base-host-ready")',
            REMOTE_SCRIPT,
        )

    def test_access_shape_never_emits_temporary_ssh_material(self):
        access = {
            "privateKey": "PRIVATE-MATERIAL",
            "certKey": "CERT-MATERIAL",
            "ipAddress": "198.51.100.20",
            "username": "ubuntu",
            "protocol": "ssh",
            "hostKeys": [
                {
                    "algorithm": "ssh-ed25519",
                    "publicKey": "ssh-ed25519 PUBLIC-MATERIAL",
                }
            ],
        }
        shape = access_shape(access)
        self.assertTrue(shape["has_private_key"])
        self.assertTrue(shape["has_cert_key"])
        self.assertEqual(shape["host_key_count"], 1)
        self.assertEqual(shape["host_key_algorithms"], ["ssh-ed25519"])
        self.assertEqual(shape["host_key_public_prefixed_count"], 1)
        raw = json.dumps(shape)
        for private in ("PRIVATE-MATERIAL", "CERT-MATERIAL", "198.51.100.20", "PUBLIC-MATERIAL"):
            self.assertNotIn(private, raw)

    def test_known_hosts_uses_only_lightsail_witnessed_host_keys(self):
        access = {
            "ipAddress": "198.51.100.20",
            "hostKeys": [
                {
                    "algorithm": "ssh-ed25519",
                    "publicKey": "ssh-ed25519 AAAAC3NzaSynthetic",
                }
            ],
        }
        known = known_hosts_text(access)
        self.assertEqual(
            known,
            "198.51.100.20 ssh-ed25519 AAAAC3NzaSynthetic\n",
        )
        with self.assertRaises(ValueError):
            known_hosts_text({"ipAddress": "198.51.100.20", "hostKeys": []})

    def test_remote_validation_accepts_only_safe_shapes(self):
        result = validate_remote(self.remote())
        self.assertEqual(result["compose_version"], "2.33.1")
        self.assertEqual(result["disk_free_gib"], 53)
        raw = json.dumps(result)
        self.assertNotIn("198.51.100", raw)

        bad = self.remote()
        bad["docker_server_version"] = "27.5.1 secret value"
        with self.assertRaises(ValueError):
            validate_remote(bad)

    def test_release_staging_requires_host_security_compose_disk_and_ecr(self):
        good = self.remote()
        ready = deploy_prerequisites(good, True)
        self.assertTrue(ready["ready_for_release_staging"])

        for mutate in (
            lambda r: r.update(base_host_ready=False),
            lambda r: r.update(compose_version="2.29.9"),
            lambda r: r.update(current_release_present=True),
            lambda r: r.update(disk_free_gib=19),
        ):
            remote = self.remote()
            mutate(remote)
            self.assertFalse(
                deploy_prerequisites(remote, True)["ready_for_release_staging"]
            )
        self.assertFalse(
            deploy_prerequisites(self.remote(), False)["ready_for_release_staging"]
        )

    def test_version_tuple(self):
        self.assertGreaterEqual(version_tuple("2.30.0"), (2, 30, 0))
        self.assertGreaterEqual(version_tuple("2.33.1+ubuntu"), (2, 30, 0))
        self.assertLess(version_tuple("2.29.9"), (2, 30, 0))
        self.assertEqual(version_tuple("unknown"), ())


if __name__ == "__main__":
    unittest.main()
