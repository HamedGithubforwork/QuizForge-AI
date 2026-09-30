"""Read-only checks for adding the already registered native client to one release.

No client registration, permissions changes, credentials or deployment writes.
"""
import json
from pathlib import Path
import re
import subprocess
import tempfile


def activation_client(source, candidate_sha, public, application, cognito):
    if not source.exists():
        return None
    pin = json.loads(source.read_text())
    if (set(pin) != {"schema", "application_candidate_sha"} or type(pin["schema"]) is not int or pin["schema"] != 1
            or not isinstance(pin["application_candidate_sha"], str)
            or not re.fullmatch(r"[0-9a-f]{40}", pin["application_candidate_sha"])):
        raise ValueError("Invalid desktop activation pin")
    # Existing frozen releases remain web-only. The new audience is scoped to
    # an explicit application commit, never to latest/main or every pool client.
    if candidate_sha != pin["application_candidate_sha"]:
        return None
    config_path = application / "desktop/src/native-runtime.json"
    if config_path.stat().st_size > 4096:
        raise ValueError("Oversized desktop routing configuration")
    config = json.loads(config_path.read_text())
    if (set(config) != {"schema", "poolId", "clientId"} or type(config["schema"]) is not int or config["schema"] != 1
            or config["poolId"] != public["pool"] or config["clientId"] == public["client"]
            or not isinstance(config["clientId"], str) or not re.fullmatch(r"[a-z0-9]{1,128}", config["clientId"])):
        raise ValueError("Desktop routing does not match this release")
    response = cognito.describe_user_pool_client(UserPoolId=public["pool"], ClientId=config["clientId"])
    if response.get("UserPoolClient", {}).get("ClientId") != config["clientId"]:
        raise ValueError("Desktop client identity mismatch")
    raw = json.dumps(response, default=str)
    if len(raw.encode()) > 65536:
        raise ValueError("Oversized desktop policy response")
    with tempfile.TemporaryDirectory() as directory:
        description = Path(directory) / "description.json"
        description.write_text(raw)
        description.chmod(0o600)
        result = subprocess.run(["node", str(application / "desktop/scripts/native-client-config.cjs"),
                                 "verify", public["pool"], public["client"], str(description)],
                                capture_output=True, text=True, timeout=15, check=False)
    if result.returncode:
        raise ValueError("Registered desktop client no longer matches reviewed policy")
    return config["clientId"]
