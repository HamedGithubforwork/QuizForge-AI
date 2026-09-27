"""Credentialless frontend build. Reject privileged keys before invoking Vite."""
import base64
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def public_config(config):
    expected = {"pool", "client", "auth_origin", "frontend_url", "api_url", "legacy_url", "legacy_publishable_key", "sms_mfa_enabled"}
    if not isinstance(config, dict) or set(config) != expected:
        raise ValueError("Only exact public build configuration fields are permitted")
    if any(not isinstance(config[key], str) for key in expected - {"sms_mfa_enabled"}):
        raise ValueError("Only string endpoint values are permitted")
    if type(config["sms_mfa_enabled"]) is not bool:
        raise ValueError("SMS MFA availability must be an explicit boolean")
    if (config["frontend_url"] != "https://quizfromnotes.com" or config["api_url"] != "https://api.quizfromnotes.com"
            or config["legacy_url"] != "https://vfxmsvphgcaizqnbyjip.supabase.co"
            or not re.fullmatch(r"ca-central-1_[A-Za-z0-9]{1,55}",config["pool"])
            or not re.fullmatch(r"[a-z0-9]{1,128}",config["client"])
            or not re.fullmatch(r"https://quizforge-[0-9]{12}\.auth\.ca-central-1\.amazoncognito\.com",config["auth_origin"])):
        raise ValueError("Unexpected production endpoint configuration")
    key = config["legacy_publishable_key"]
    if re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]{20,}",key):
        return config
    try:
        if len(key) > 8192 or len(key.split('.')) != 3:
            raise ValueError
        payload = key.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        if claims.get('role') != 'anon' or claims.get('ref') != 'vfxmsvphgcaizqnbyjip':
            raise ValueError
    except Exception:
        raise ValueError("Only a verified source publishable/anon configuration key may enter the build") from None
    return config


COGNITO_GATE_SOURCE = """export { default } from './CognitoAuthGate'\n"""

COGNITO_SESSION_SOURCE = """import { session } from './cognitoBrowser'

export type AuthSession = {
  accessToken: string
  userId: string
  email: string
}

export async function authSession(
  refresh = false,
): Promise<AuthSession | null> {
  return session(refresh)
}
"""


def narrow_production_auth_source(frontend):
    src = frontend / "src"
    required = [
        src / "CognitoAuthGate.tsx",
        src / "SupabaseAuthGate.tsx",
        src / "AuthGate.tsx",
        src / "lib" / "authSession.ts",
        src / "lib" / "cognitoBrowser.ts",
        src / "lib" / "supabase.ts",
    ]
    missing = [path.relative_to(frontend).as_posix() for path in required if not path.is_file()]
    if missing:
        raise ValueError("Pinned frontend lacks reviewed auth source: " + ", ".join(missing))

    (src / "AuthGate.tsx").write_text(COGNITO_GATE_SOURCE, encoding="utf-8")
    (src / "lib" / "authSession.ts").write_text(COGNITO_SESSION_SOURCE, encoding="utf-8")

    legacy_gate = src / "SupabaseAuthGate.tsx"
    legacy_adapter = src / "lib" / "supabase.ts"
    excluded = {legacy_gate.resolve(), legacy_adapter.resolve()}
    local_adapter = re.compile(
        r"""(?:from\s+|import\()\s*['"](?:\.\.?/)+[^'"]*supabase(?:\.ts)?['"]"""
    )
    for candidate in src.rglob("*"):
        if candidate.suffix not in {".ts", ".tsx"} or candidate.resolve() in excluded:
            continue
        if local_adapter.search(candidate.read_text(encoding="utf-8")):
            raise ValueError(
                "Unexpected production dependency on legacy Supabase adapter: "
                + candidate.relative_to(frontend).as_posix()
            )

    legacy_gate.unlink()
    legacy_adapter.unlink()


def main():
    config = public_config(json.loads(Path(sys.argv[1]).read_text()))
    source, destination = Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve()
    # Inputs are copied without inherited local env files, credentials or build output.
    shutil.copytree(source,destination,ignore=shutil.ignore_patterns('.env*','node_modules','dist','.git'))
    # Production is Cognito-only. Keep the Supabase SDK only for the explicit,
    # non-persistent legacy-account ownership proof inside CognitoAuthGate.
    narrow_production_auth_source(destination)
    env = {name:os.environ[name] for name in ('PATH','HOME','CI') if name in os.environ}
    env.update(VITE_COGNITO_ENVIRONMENT='production',
               VITE_COGNITO_USER_POOL_ID=config['pool'],VITE_COGNITO_CLIENT_ID=config['client'],
               VITE_COGNITO_DOMAIN=config['auth_origin'],VITE_API_URL=config['api_url'],
               VITE_IDENTITY_API_URL=config['api_url'],VITE_SUPABASE_URL=config['legacy_url'],
               VITE_SUPABASE_PUBLISHABLE_KEY=config['legacy_publishable_key'],
               VITE_COGNITO_SMS_MFA_ENABLED='true' if config['sms_mfa_enabled'] else 'false')
    subprocess.run(['npm','ci','--ignore-scripts'],cwd=destination,env=env,check=True)
    subprocess.run(['npm','run','build'],cwd=destination,env=env,check=True)
    print('PASS: production frontend built with validated public configuration only')


if __name__ == '__main__': main()
