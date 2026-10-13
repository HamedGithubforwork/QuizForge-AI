"""Deterministic recovery package; preserve verified deployed bytes for Google-only plans."""
import argparse
import base64
import hashlib
import io
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[3]
FUNCTION = "quizforge-production-lightsail-recovery"
FUNCTION_ARN = "arn:aws:lambda:ca-central-1:399311815467:function:" + FUNCTION
# Reviewed archive/aws-migration-2026-09-26 @ 43894cc78eaa4b7da94fd4375bd929d64addca6b.
# These are the original production bundle, not newly enabled signup triggers.
RETAINED_SOURCES = {
    "identity_triggers.py": "4a4311d1854c44b862eb79f29184bb9080b88417d86d229a8ffdb3ca7bf2619c",
    "pre_signup.py": "017faedad1d852c9e230e822d64f9f6be9cf85243786eb4b4c09bab1bafc7d9f",
}


def package(retained_source: Path | None = None) -> bytes:
    sources = {}
    if retained_source is None:
        sources["identity_triggers.py"] = Path(__file__).with_name("identity_triggers.py").read_bytes()
    else:
        for name, digest in RETAINED_SOURCES.items():
            content = (retained_source / name).read_bytes()
            if hashlib.sha256(content).hexdigest() != digest:
                raise ValueError("Retained recovery source differs from reviewed archive")
            sources[name] = content
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in sources.items():
            archive.writestr(zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0)), content)
    return buffer.getvalue()


def verify_deployed(client, content: bytes) -> None:
    configuration = client.get_function_configuration(FunctionName=FUNCTION)
    digest = base64.b64encode(hashlib.sha256(content).digest()).decode("ascii")
    expected = {
        "FunctionName": FUNCTION, "FunctionArn": FUNCTION_ARN,
        "Runtime": "python3.13", "Handler": "identity_triggers.handler",
        "PackageType": "Zip", "CodeSha256": digest,
    }
    if any(configuration.get(key) != value for key, value in expected.items()):
        raise ValueError("Deployed recovery package differs; separate recovery review required")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--retained-production-source", type=Path)
    parser.add_argument("--verify-deployed", action="store_true")
    args = parser.parse_args()
    if args.verify_deployed and args.retained_production_source is None:
        parser.error("--verify-deployed requires the reviewed retained production source")
    try:
        content = package(args.retained_production_source)
        if args.verify_deployed:
            import boto3
            verify_deployed(boto3.client("lambda", region_name="ca-central-1"), content)
        (ROOT / "infra/aws/lightsail-production/recovery.zip").write_bytes(content)
    except Exception as error:
        category = {
            "Retained recovery source differs from reviewed archive": "ARCHIVE_SOURCE_DIFFERS",
            "Deployed recovery package differs; separate recovery review required": "LIVE_RECOVERY_DIFFERS",
        }.get(str(error), "PACKAGE_VERIFICATION_FAILED")
        if getattr(error, "response", {}).get("Error", {}).get("Code") in {
            "AccessDenied", "AccessDeniedException",
        }:
            category = "AWS_READ_PERMISSION_DENIED"
        raise SystemExit("FAIL: recovery package not verified; category=" + category +
                         "; no AWS changes made") from None
    if args.verify_deployed:
        print("PASS: retained recovery package matches deployed digest; no Lambda changes made")


if __name__ == "__main__":
    main()
