"""Protected history delivery: in-memory AES-GCM, private S3, separate key secret.

Upload is a read-only source export. Import is a private-VPC operation and defaults
to SQL rollback. Commit requires the independently reviewed full-content digest.
Neither mode exports credentials, records, user IDs or encryption keys to logs.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys

import boto3
import psycopg

from database import options, SOURCE_ISSUER
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rds_rehearsal"))
from history_transfer import SUPABASE, export_snapshot, import_snapshot, seal, unseal, validate


def validate_delivery(bucket, secret):
    if not re.fullmatch(r"quizforge-production-transfer-[0-9]{12}", bucket):
        raise ValueError("Unexpected transfer bucket")
    account = bucket.rsplit("-", 1)[1]
    if not re.fullmatch(r"arn:aws:secretsmanager:ca-central-1:" + account +
                        r":secret:quizforge-production-transfer-key-[A-Za-z0-9]{6}", secret):
        raise ValueError("Unexpected transfer key secret")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["upload", "import"])
    parser.add_argument("--object-key")
    parser.add_argument("--expected-sha256")
    parser.add_argument("--commit", action="store_true")
    args = parser.parse_args(argv)
    bucket, secret = os.environ["TRANSFER_BUCKET"], os.environ["TRANSFER_SECRET"]
    validate_delivery(bucket, secret)
    s3 = boto3.client("s3", region_name="ca-central-1")
    manager = boto3.client("secretsmanager", region_name="ca-central-1")
    key = base64.b64decode(manager.get_secret_value(SecretId=secret)["SecretString"], validate=True)
    if len(key) != 32:
        raise ValueError("Invalid transfer key")
    if args.operation == "upload":
        if args.commit or args.object_key or args.expected_sha256:
            raise ValueError("Export cannot commit a database change or overwrite an archive")
        block = s3.get_public_access_block(Bucket=bucket)["PublicAccessBlockConfiguration"]
        if not all(block.get(name) for name in ("BlockPublicAcls", "BlockPublicPolicy", "IgnorePublicAcls", "RestrictPublicBuckets")):
            raise ValueError("Transfer bucket is not private")
        with psycopg.connect(**options(os.environ, source=True)) as source:
            snapshot = export_snapshot(source, SUPABASE, SOURCE_ISSUER)
        encrypted = seal(snapshot, key)
        object_key = "imports/" + hashlib.sha256(encrypted).hexdigest() + ".qfh"
        s3.put_object(Bucket=bucket, Key=object_key, Body=encrypted, ServerSideEncryption="AES256",
                      ContentType="application/octet-stream", IfNoneMatch="*")
    else:
        if not args.object_key or not re.fullmatch(r"imports/[a-f0-9]{64}\.qfh", args.object_key):
            raise ValueError("An exact content-addressed encrypted archive is required")
        obj = s3.get_object(Bucket=bucket, Key=args.object_key)
        try:
            if obj["ContentLength"] > 32 * 1024 * 1024 + 128:
                raise ValueError("Archive exceeds transfer limit")
            encrypted = obj["Body"].read(32 * 1024 * 1024 + 129)
        finally:
            obj["Body"].close()
        if hashlib.sha256(encrypted).hexdigest() != args.object_key[8:-4]:
            raise ValueError("Encrypted archive content-address mismatch")
        snapshot = unseal(encrypted, key)
        manifest = validate(snapshot)
        if snapshot["issuer"] != SOURCE_ISSUER:
            raise ValueError("Unexpected identity source")
        if args.commit and (not args.expected_sha256 or args.expected_sha256 != manifest["sha256"]):
            raise ValueError("Commit requires the recorded export digest")
        with psycopg.connect(**options(os.environ)) as target:
            import_snapshot(target, snapshot, dry_run=not args.commit)
        object_key = args.object_key
    manifest = validate(snapshot)
    print(json.dumps({"users": manifest["users"], "rows": manifest["rows"], "sha256": manifest["sha256"],
                      "archive": object_key, "committed": args.commit}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("ERROR: encrypted delivery stopped (" + type(error).__name__ + "); private values omitted")
        raise SystemExit(1) from None
