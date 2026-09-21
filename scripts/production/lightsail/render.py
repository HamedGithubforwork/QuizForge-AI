"""Render an inactive, digest-pinned single-host release. Never contacts AWS.

Inputs contain public settings and explicit owner decisions, not credentials.
Secrets are separately delivered as private files referenced by Compose.
"""
import argparse
import ipaddress
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build import public_config

HERE = Path(__file__).resolve().parent


def validate(config):
    if set(config) != {"public", "images", "monthly_budget_usd", "alert_email", "ssh_public_key", "admin_ipv4_cidr", "ai_daily_requests", "ai_monthly_requests"}:
        raise ValueError("Use only the documented release fields; credentials are separate")
    public_config(config["public"])
    images = config["images"]
    if set(images) != {"api", "operations", "postgres", "redis", "caddy"}:
        raise ValueError("All five reviewed image digests are required")
    for name, value in images.items():
        repository = (r"[0-9]{12}\.dkr\.ecr\.ca-central-1\.amazonaws\.com/quizforge-api" if name in {"api", "operations", "caddy"}
                      else "docker.io/library/" + name)
        if not isinstance(value, str) or not re.fullmatch(repository + r"@sha256:[a-f0-9]{64}", value):
            raise ValueError("Every image must use its reviewed registry and immutable digest")
    if type(config["monthly_budget_usd"]) not in (int, float) or not 12 <= config["monthly_budget_usd"] <= 1000:
        raise ValueError("Choose an explicit monthly AWS alert budget")
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", config["alert_email"]) or config["alert_email"].endswith(".invalid"):
        raise ValueError("A real owner-selected alert email is required")
    network = ipaddress.ip_network(config["admin_ipv4_cidr"], strict=True)
    if network.version != 4 or network.prefixlen != 32:
        raise ValueError("SSH is restricted to one operator IPv4 /32")
    if not re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [^\r\n]+)?", config["ssh_public_key"]):
        raise ValueError("Supply only an Ed25519 public SSH key")
    day, month = config["ai_daily_requests"], config["ai_monthly_requests"]
    if type(day) is not int or type(month) is not int or not 0 <= day <= min(month, 1000) or not month <= 10000:
        raise ValueError("Choose request limits within 0–1000 daily and 0–10000 monthly")
    return config


def compose(config):
    validate(config)
    public, images = config["public"], config["images"]

    def service(image, memory, uid="10001:10001"):
        return dict(image=images[image], user=uid, read_only=True, restart="unless-stopped", init=True,
                    cap_drop=["ALL"], security_opt=["no-new-privileges:true"], pids_limit=96,
                    mem_limit=f"{memory}m", memswap_limit=f"{memory}m", cgroup_parent="quizforge.slice",
                    tmpfs=["/tmp:size=32m,mode=1777,noexec,nosuid,nodev"],
                    logging={"driver": "local", "options": {"max-size": "5m", "max-file": "2"}})

    common = {"AUTH_PROVIDER": "cognito", "COGNITO_USER_POOL_ID": public["pool"],
              "COGNITO_CLIENT_ID": public["client"], "AWS_EC2_METADATA_DISABLED": "true"}
    services = {}
    for name, prefix, role, port, memory in (("api", "HISTORY_DB", "app", 8000, 704), ("identity", "IDENTITY_DB", "identity", 8001, 128)):
        settings = common | {prefix + "_HOST": "db.quizforge.internal", prefix + "_NAME": "quizforge",
                             prefix + "_USER": "quizforge_" + role, prefix + "_POOL_SIZE": "1",
                             prefix + "_SSLROOTCERT": "/run/quizforge/db-ca.pem"}
        command = ["uvicorn", "main:app"] if name == "api" else ["uvicorn", "identity_app:create_identity_app", "--factory"]
        services[name] = service("api", memory) | {
            "environment": settings, "env_file": [{"path": f"/etc/quizforge/{name}.env", "format": "raw"}],
            "command": command + ["--host", "0.0.0.0", "--port", str(port), "--workers", "1", "--no-access-log", "--no-proxy-headers"],
            "ports": [f"127.0.0.1:{port}:{port}"],
            "volumes": ["/etc/quizforge/db-ca.pem:/run/quizforge/db-ca.pem:ro"],
            "depends_on": {"db": {"condition": "service_healthy"}},
            "healthcheck": {"test": ["CMD", "python", "-c", "import socket; socket.create_connection(('127.0.0.1'," + str(port) + "),2).close()"], "interval": "30s", "timeout": "5s", "retries": 3}}
    services["api"]["environment"].update(HISTORY_BACKEND="postgres", ALLOWED_ORIGINS=public["frontend_url"],
        REDIS_URL="redis://redis:6379/0", OPENAI_API_KEY="production-budget-guard", OPENAI_BASE_URL="http://127.0.0.1:8002/v1",
        PDF_PROCESS_ISOLATION="true", PDF_BACKGROUND_JOBS="true", PDF_JOB_DIR="/var/lib/quizforge/pdf-jobs", OMP_THREAD_LIMIT="1")
    services["api"]["volumes"].append("/var/lib/quizforge/pdf-jobs:/var/lib/quizforge/pdf-jobs")
    services["api"]["depends_on"]["redis"] = {"condition": "service_healthy"}
    services["identity"]["environment"].update(IDENTITY_ENVIRONMENT="production", PRODUCTION_DATABASE_TARGET="lightsail",
        IDENTITY_ALLOWED_ORIGIN=public["frontend_url"], IDENTITY_SUPABASE_URL=public["legacy_url"],
        IDENTITY_SUPABASE_PUBLISHABLE_KEY=public["legacy_publishable_key"])
    services["guard"] = service("operations", 96) | {
        "network_mode": "service:api", "command": ["python", "generation_guard.py"],
        "env_file": [{"path": "/etc/quizforge/generation.env", "format": "raw"}],
        "environment": {"PGHOST": "db.quizforge.internal", "PGDATABASE": "quizforge", "PGUSER": "quizforge_generation",
                        "PGSSLROOTCERT": "/run/quizforge/db-ca.pem", "PRODUCTION_DATABASE_TARGET": "lightsail", "AWS_EC2_METADATA_DISABLED": "true"},
        "volumes": ["/etc/quizforge/db-ca.pem:/run/quizforge/db-ca.pem:ro"],
        "depends_on": {"api": {"condition": "service_healthy", "restart": True}}}
    services["db"] = service("postgres", 192, "999:999") | {
        "environment": {"POSTGRES_DB": "quizforge", "POSTGRES_USER": "quizforge_owner", "POSTGRES_PASSWORD_FILE": "/run/quizforge/owner-password"},
        "ports": ["127.0.0.1:5432:5432"], "networks": {"default": {"aliases": ["db.quizforge.internal"]}},
        "volumes": ["/var/lib/quizforge/postgres:/var/lib/postgresql/data", "/etc/quizforge/postgres:/run/quizforge:ro", "./postgresql.conf:/etc/postgresql/postgresql.conf:ro", "./pg_hba.conf:/etc/postgresql/pg_hba.conf:ro"],
        "tmpfs": ["/tmp:size=16m,mode=1777", "/var/run/postgresql:size=8m,uid=999,gid=999,mode=0700"],
        "command": ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"],
        "healthcheck": {"test": ["CMD", "pg_isready", "-U", "quizforge_owner", "-d", "quizforge"], "interval": "10s", "timeout": "5s", "retries": 6}}
    services["redis"] = service("redis", 64, "999:999") | {
        "command": ["redis-server", "--save", "", "--appendonly", "no", "--maxmemory", "32mb", "--maxmemory-policy", "allkeys-lru"],
        "healthcheck": {"test": ["CMD", "redis-cli", "ping"], "interval": "10s", "timeout": "3s", "retries": 3}}
    services["web"] = service("caddy", 64) | {
        "ports": ["80:8080", "443:8443"], "environment": {"XDG_DATA_HOME": "/data", "XDG_CONFIG_HOME": "/config"},
        "volumes": ["./Caddyfile:/etc/caddy/Caddyfile:ro", "/opt/quizforge/frontend:/srv:ro", "/var/lib/quizforge/caddy-data:/data", "/var/lib/quizforge/caddy-config:/config"],
        "depends_on": {name: {"condition": "service_healthy"} for name in ("api", "identity")}}
    return {"name": "quizforge-production", "services": services}


def render(config, destination):
    stack = compose(config)
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    files = {"compose.json": json.dumps(stack, indent=2) + "\n",
             "production.auto.tfvars.json": json.dumps({k: config[k] for k in ("monthly_budget_usd", "alert_email", "ssh_public_key", "admin_ipv4_cidr")}, indent=2) + "\n",
             "backup.auto.tfvars.json": json.dumps({"alert_email": config["alert_email"]}) + "\n",
             # Choosing limits never enables calls; separate activation after acceptance.
             "reviewed-ai-policy.sql": f"UPDATE billing.generation_policy SET enabled=false, daily_requests={config['ai_daily_requests']}, monthly_requests={config['ai_monthly_requests']} WHERE singleton;\n"}
    for name in ("postgresql.conf", "pg_hba.conf", "Caddyfile"):
        files[name] = (HERE / name).read_text().replace("__AUTH_ORIGIN__", config["public"]["auth_origin"])
    for name, content in files.items():
        with (destination / name).open("x") as handle:
            (destination / name).chmod(0o600)
            handle.write(content)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    render(json.loads(args.config.read_text()), args.destination)
    print("Prepared inactive release; no cloud changes, service startup or model calls")
