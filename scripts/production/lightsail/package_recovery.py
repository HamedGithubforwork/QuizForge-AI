"""Deterministic local recovery-hook package; never uploads or deploys it."""
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[3]
source = Path(__file__).with_name("identity_triggers.py")
with zipfile.ZipFile(root / "infra/aws/lightsail-production/recovery.zip", "w") as archive:
    archive.writestr(
        zipfile.ZipInfo("identity_triggers.py", (2026, 1, 1, 0, 0, 0)),
        source.read_bytes(),
    )
