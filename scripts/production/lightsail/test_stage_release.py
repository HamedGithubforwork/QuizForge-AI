from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.production.lightsail.stage_release import (
    load_pins,
    preflight_ok,
    validate_manifest,
    write_report,
)


class StageReleaseTests(unittest.TestCase):
    def test_pinned_host_keys_are_exact_and_complete(self):
        pins = load_pins(Path("scripts/production/lightsail/ssh-host-pins.json"))
        self.assertEqual(len(pins), 3)
        self.assertTrue(any(algorithm == "ssh-ed25519" for algorithm, _ in pins))

    def test_manifest_requires_five_digest_pinned_images(self):
        value = {
            "schema": 1,
            "release_sha": "a" * 40,
            "frontend_tree_sha256": "b" * 64,
            "images": [
                "123456789012.dkr.ecr.ca-central-1.amazonaws.com/quizforge-api@sha256:" + "1" * 64,
                "123456789012.dkr.ecr.ca-central-1.amazonaws.com/quizforge-api@sha256:" + "2" * 64,
                "123456789012.dkr.ecr.ca-central-1.amazonaws.com/quizforge-api@sha256:" + "3" * 64,
                "docker.io/library/postgres@sha256:" + "4" * 64,
                "docker.io/library/redis@sha256:" + "5" * 64,
            ],
        }
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "manifest.json"
            path.write_text(json.dumps(value))
            self.assertEqual(validate_manifest(path)["release_sha"], "a" * 40)

            bad = dict(value)
            bad["images"] = value["images"][:-1]
            path.write_text(json.dumps(bad))
            with self.assertRaises(ValueError):
                validate_manifest(path)

    def test_preflight_requires_clean_hardened_host_and_capacity(self):
        value = {
            "base_host_ready": True,
            "ubuntu_24_04": True,
            "sudo_noninteractive": True,
            "docker_active": True,
            "compose_ok": True,
            "cgroup_v2": True,
            "swap_disabled": True,
            "etc_private": True,
            "var_private": True,
            "current_release_absent": True,
            "frontend_absent": True,
            "launch_marker_absent": True,
            "service_inactive": True,
            "ssh_password_disabled": True,
            "ssh_root_disabled": True,
            "ssh_forwarding_disabled": True,
            "disk_free_gib": 50,
        }
        self.assertTrue(preflight_ok(value))
        value["compose_ok"] = False
        self.assertFalse(preflight_ok(value))

    def test_summary_rejects_private_or_ip_values(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "summary.json"
            with patch("scripts.production.lightsail.stage_release.RESULT", target):
                with self.assertRaises(ValueError):
                    write_report({"unsafe": "198.51.100.20"}, [])
                with self.assertRaises(ValueError):
                    write_report({"unsafe": "secret-token"}, ["secret-token"])
                write_report(
                    {
                        "result": "release_staged_inactive",
                        "host_key_pin_verified": True,
                    },
                    [],
                )
                self.assertTrue(target.is_file())


if __name__ == "__main__":
    unittest.main()
