"""Credentialless reviewed frontend build, accepting only public staging settings."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "frontend_staging"))
from control import inventory
from importlib.util import module_from_spec, spec_from_file_location
spec = spec_from_file_location("integration_guards", Path(__file__).with_name("guards.py"))
guards = module_from_spec(spec)
spec.loader.exec_module(guards)


def main():
    config = guards.public_config(json.loads(Path("integration-config.json").read_text()))
    source = Path(sys.argv[1]).resolve()
    target = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "quizforge-integrated-build"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target, ignore=shutil.ignore_patterns(".env*", "node_modules", "dist", ".git"))
    env = {k:os.environ[k] for k in ("PATH", "HOME", "CI") if k in os.environ}
    env.update(VITE_AUTH_PROVIDER="cognito", VITE_COGNITO_STAGING="true",
               VITE_COGNITO_USER_POOL_ID=config["pool"], VITE_COGNITO_CLIENT_ID=config["client"],
               VITE_COGNITO_DOMAIN=config["auth_origin"], VITE_API_URL=config["api_url"],
               VITE_IDENTITY_API_URL=config["api_url"])
    subprocess.run(["npm", "ci", "--ignore-scripts"], cwd=target, env=env, check=True)
    subprocess.run(["npm", "run", "build"], cwd=target, env=env, check=True)
    shutil.copytree(target / "dist", "hosting-dist")
    Path("hosting-manifest.json").write_text(json.dumps(inventory("hosting-dist"), sort_keys=True))
    print("PASS: reviewed frontend built with exact public integrated-staging settings and no credentials")


if __name__ == "__main__":
    main()
