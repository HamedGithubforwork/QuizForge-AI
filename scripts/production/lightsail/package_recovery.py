"""Deterministic local recovery-hook package; never uploads or deploys it."""
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[3]
with zipfile.ZipFile(root / 'infra/aws/lightsail-production/recovery.zip', 'w') as archive:
    for name in ('identity_triggers.py', 'pre_signup.py'):
        archive.writestr(zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0)),
                         (root / 'scripts/cognito_browser' / name).read_bytes())
