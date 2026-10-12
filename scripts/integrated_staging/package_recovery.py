"""Build staging's recovery hook from the same reviewed production source.

Generate only a deterministic local artifact. Never uploads to AWS or alters
the production recovery archive.
"""
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "scripts/production/lightsail/identity_triggers.py"
DEST = ROOT / "infra/aws/integrated-staging/recovery.zip"
ENTRY = "identity_triggers.py"
STAMP = (2026, 1, 1, 0, 0, 0)


def package(destination=DEST):
    source = SOURCE.read_bytes()
    output = Path(destination)
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(zipfile.ZipInfo(ENTRY, STAMP), source)
    with zipfile.ZipFile(output) as archive:
        if archive.namelist() != [ENTRY] or archive.read(ENTRY) != source:
            raise ValueError("Staging recovery package is not production-identical")
    return output


if __name__ == "__main__":
    if len(sys.argv) != 1:
        raise SystemExit("No alternative deployment destination permitted")
    package()
    print("PASS: disposable recovery Lambda uses exact production handler bytes")
