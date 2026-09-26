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


def main():
    config = public_config(json.loads(Path(sys.argv[1]).read_text()))
    source, destination = Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve()
    # Inputs are copied without inherited local env files, credentials or build output.
    shutil.copytree(source,destination,ignore=shutil.ignore_patterns('.env*','node_modules','dist','.git'))
    env = {name:os.environ[name] for name in ('PATH','HOME','CI') if name in os.environ}
    env.update(VITE_AUTH_PROVIDER='cognito',VITE_COGNITO_ENVIRONMENT='production',
               VITE_COGNITO_USER_POOL_ID=config['pool'],VITE_COGNITO_CLIENT_ID=config['client'],
               VITE_COGNITO_DOMAIN=config['auth_origin'],VITE_API_URL=config['api_url'],
               VITE_IDENTITY_API_URL=config['api_url'],VITE_SUPABASE_URL=config['legacy_url'],
               VITE_SUPABASE_PUBLISHABLE_KEY=config['legacy_publishable_key'],
               VITE_COGNITO_SMS_MFA_ENABLED='true' if config['sms_mfa_enabled'] else 'false')
    subprocess.run(['npm','ci','--ignore-scripts'],cwd=destination,env=env,check=True)
    subprocess.run(['npm','run','build'],cwd=destination,env=env,check=True)
    print('PASS: production frontend built with validated public configuration only')


if __name__ == '__main__': main()
