"""Build the reviewed application on a runner with no AWS identity or secrets."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from control import inventory


def main():
    source = Path(sys.argv[1]).resolve()
    target = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "quizforge-frontend-build"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target, ignore=shutil.ignore_patterns(
        ".env*", "node_modules", "dist", ".git"))
    # Vite also reads process environment: inherit an explicit non-secret allowlist.
    env = {k: os.environ[k] for k in ("PATH", "HOME", "CI") if k in os.environ}
    env.update({
        "VITE_AUTH_PROVIDER": "cognito", "VITE_COGNITO_STAGING": "true",
        "VITE_COGNITO_USER_POOL_ID": "ca-central-1_HostingOnly",
        "VITE_COGNITO_CLIENT_ID": "hostingonly",
        "VITE_COGNITO_DOMAIN": "https://quizforge-hosting-only.auth.ca-central-1.amazoncognito.com",
        "VITE_API_URL": "https://hosting-test.invalid",
        "VITE_IDENTITY_API_URL": "https://hosting-test.invalid",
    })
    subprocess.run(["npm", "ci", "--ignore-scripts"], cwd=target, env=env, check=True)
    subprocess.run(["npm", "run", "build"], cwd=target, env=env, check=True)
    destination = Path("hosting-dist")
    shutil.copytree(target / "dist", destination)
    files = inventory(destination)
    Path("hosting-manifest.json").write_text(json.dumps(files, sort_keys=True))
    print(f"PASS: reviewed frontend built with isolated hosting-only settings ({len(files)} files)")


if __name__ == "__main__":
    main()
