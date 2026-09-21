import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, MagicMock
from urllib.error import HTTPError

from database import options
from generation_guard import connection_options
from lightsail.render import compose, render, validate
from lightsail import host_health


def fixture():
    return {
        "public": {"pool": "ca-central-1_Synthetic", "client": "syntheticclient",
            "auth_origin": "https://quizforge-123456789012.auth.ca-central-1.amazoncognito.com",
            "frontend_url": "https://quizfromnotes.com", "api_url": "https://api.quizfromnotes.com",
            "legacy_url": "https://vfxmsvphgcaizqnbyjip.supabase.co",
            "legacy_publishable_key": "sb_publishable_synthetic_public_key_12345"},
        "images": {name: ("123456789012.dkr.ecr.ca-central-1.amazonaws.com/quizforge-api" if name in ("api", "operations", "caddy") else "docker.io/library/" + name) + "@sha256:" + "a" * 64
                   for name in ("api", "operations", "postgres", "redis", "caddy")},
        "monthly_budget_usd": 20, "alert_email": "synthetic@example.com", "ssh_public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakesynthetickeyonly",
        "admin_ipv4_cidr": "192.0.2.10/32", "ai_daily_requests": 0, "ai_monthly_requests": 0}


class Configuration(unittest.TestCase):
    def test_host_heartbeat_rejects_disk_pressure_and_either_failed_service(self):
        with patch.object(host_health.shutil, "disk_usage", return_value=SimpleNamespace(total=60 * 1024**3, free=1024**3)):
            self.assertFalse(host_health.healthy())
        with patch.object(host_health.shutil, "disk_usage", return_value=SimpleNamespace(total=60 * 1024**3, free=30 * 1024**3)), patch.object(host_health, "build_opener") as factory:
            response = MagicMock()
            response.__enter__.return_value.status = 200
            factory.return_value.open.side_effect = [response, HTTPError("local", 403, "blocked", {}, None)]
            self.assertTrue(host_health.healthy())
            factory.return_value.open.side_effect = [response, OSError("offline")]
            self.assertFalse(host_health.healthy())
            factory.return_value.open.side_effect = OSError("offline")
            self.assertFalse(host_health.healthy())

    def test_requires_owner_decisions_and_rejects_mutable_images_or_secrets(self):
        for key, bad in (("monthly_budget_usd", None), ("monthly_budget_usd", 5), ("alert_email", "owner@example.invalid"),
                         ("admin_ipv4_cidr", "0.0.0.0/0"), ("admin_ipv4_cidr", "::/0"),
                         ("ai_daily_requests", None), ("ai_daily_requests", True), ("ai_daily_requests", 1001),
                         ("ai_monthly_requests", 10001), ("ssh_public_key", "PRIVATE KEY")):
            with self.subTest(key=key, bad=bad), self.assertRaises((ValueError, TypeError)):
                validate(fixture() | {key: bad})
        with self.assertRaises(ValueError): validate(fixture() | {"OPENAI_API_KEY": "secret"})
        for image in ("postgres:17", "evil.test/image@sha256:" + "a" * 64):
            config = fixture()
            config["images"]["postgres"] = image
            with self.assertRaises(ValueError): validate(config)

    def test_loopback_private_services_isolated_credentials_and_aggregate_memory(self):
        services = compose(fixture())["services"]
        for name, value in services.items():
            self.assertTrue(value["read_only"])
            self.assertEqual(value["cap_drop"], ["ALL"])
            self.assertEqual(value["mem_limit"], value["memswap_limit"])
            self.assertEqual(value["cgroup_parent"], "quizforge.slice")
            if name != "web":
                self.assertTrue(all(port.startswith("127.0.0.1:") for port in value.get("ports", [])))
        self.assertLessEqual(sum(int(s["mem_limit"][:-1]) for s in services.values()) + 256, 1536)
        self.assertEqual(services["guard"]["network_mode"], "service:api")
        self.assertNotIn("ports", services["guard"])
        self.assertNotIn("ports", services["redis"])
        self.assertEqual(services["api"]["environment"]["OPENAI_API_KEY"], "production-budget-guard")
        self.assertEqual(services["api"]["environment"]["PDF_BACKGROUND_JOBS"], "true")
        self.assertEqual(services["identity"]["environment"]["IDENTITY_DB_USER"], "quizforge_identity")
        self.assertEqual(services["identity"]["environment"]["PRODUCTION_DATABASE_TARGET"], "lightsail")
        for name in ("api", "identity", "guard"):
            self.assertEqual(len(services[name]["env_file"]), 1)
        self.assertNotIn("postgres/", json.dumps(services["api"]))

    def test_render_is_private_non_overwriting_and_never_enables_generation(self):
        with tempfile.TemporaryDirectory() as root:
            destination = Path(root) / "release"
            config = fixture() | {"ai_daily_requests": 2, "ai_monthly_requests": 10}
            render(config, destination)
            self.assertEqual(destination.stat().st_mode & 0o777, 0o700)
            for path in destination.iterdir(): self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertIn("enabled=false", (destination / "reviewed-ai-policy.sql").read_text())
            self.assertNotIn("__AUTH_ORIGIN__", (destination / "Caddyfile").read_text())
            with self.assertRaises(FileExistsError): render(config, destination)

    def test_database_opt_in_does_not_widen_source_restore_or_managed_boundaries(self):
        with tempfile.NamedTemporaryFile() as ca:
            env = {"PRODUCTION_DATABASE_TARGET": "lightsail", "PGHOST": "db.quizforge.internal", "PGDATABASE": "quizforge",
                   "PGUSER": "quizforge_generation", "PGPASSWORD": "synthetic", "PGSSLROOTCERT": ca.name}
            self.assertEqual(options(env)["sslmode"], "verify-full")
            self.assertEqual(connection_options(env)["sslmode"], "verify-full")
            for change in ({"PRODUCTION_DATABASE_TARGET": "rds"}, {"PRODUCTION_DATABASE_TARGET": "unknown"},
                           {"PGHOST": "localhost"}, {"PGHOST": "restore-db.quizforge.internal"}, {"PGPORT": "5433"},
                           {"PGSSLROOTCERT": "/missing-ca"}, {"PGPASSWORD": ""}):
                with self.subTest(change=change), self.assertRaises(ValueError): connection_options(env | change)
            with self.assertRaises(ValueError): connection_options(env | {"PGUSER": "quizforge_owner"})
            with self.assertRaises(ValueError): options(env, source=True)


if __name__ == "__main__": unittest.main()
