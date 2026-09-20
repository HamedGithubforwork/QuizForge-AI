"""Explicit encrypted migration CLI; production defaults to read-only/dry-run.

Transport/archive ownership, source write freeze, Auth signup/deletion freeze and
physical restore acceptance are external launch prerequisites. Never run against
an active source for final cutover. No records, credentials or keys are printed.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import stat
import sys

import psycopg

from database import options, SOURCE_ISSUER
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rds_rehearsal"))
from history_transfer import (APPLICATION, SUPABASE, export_snapshot, import_snapshot, seal, unseal, validate)


def private_write(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as file:
        file.write(data)


def private_read(path, maximum):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > maximum:
            raise ValueError("Input must be a private bounded regular file")
        return file.read(maximum + 1)


def summary(snapshot):
    result = validate(snapshot)
    return {key: result[key] for key in ("users", "rows", "sha256")}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["generate-key", "export-source", "import", "verify"])
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--archive")
    parser.add_argument("--commit", action="store_true")
    parser.add_argument("--expected-sha256")
    args = parser.parse_args(argv)
    if args.operation == "generate-key":
        if args.commit or args.archive or args.expected_sha256:
            raise ValueError("Key generation takes only a new private key path")
        private_write(args.key_file, secrets.token_bytes(32))
        print("PASS: separate private encryption key created")
        return
    if not args.archive or (args.commit and args.operation != "import"):
        raise ValueError("Invalid transfer arguments")
    key = private_read(args.key_file, 32)
    if len(key) != 32:
        raise ValueError("Expected a separate 256-bit key")
    if args.operation == "export-source":
        with psycopg.connect(**options(os.environ, source=True)) as conn:
            snapshot = export_snapshot(conn, SUPABASE, SOURCE_ISSUER)
        private_write(args.archive, seal(snapshot, key))
        print(json.dumps(summary(snapshot), sort_keys=True))
        return
    snapshot = unseal(private_read(args.archive, 32 * 1024 * 1024 + 128), key)
    if snapshot["issuer"] != SOURCE_ISSUER:
        raise ValueError("Archive belongs to a different identity source")
    manifest = summary(snapshot)
    if args.commit and (not args.expected_sha256 or args.expected_sha256 != manifest["sha256"]):
        raise ValueError("Committed import requires the independently recorded export digest")
    with psycopg.connect(**options(os.environ)) as conn:
        if args.operation == "verify":
            if summary(export_snapshot(conn, APPLICATION, SOURCE_ISSUER)) != manifest:
                raise ValueError("Destination reconciliation mismatch")
        else:
            import_snapshot(conn, snapshot, dry_run=not args.commit)
    print(json.dumps({"operation": args.operation, "dry_run": not args.commit, **manifest}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("ERROR: migration stopped (" + type(error).__name__ + "); records and credentials omitted")
        raise SystemExit(1) from None
