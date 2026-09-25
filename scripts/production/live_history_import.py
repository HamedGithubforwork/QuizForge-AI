"""One-time live Supabase-history import into the permanent application database."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

import psycopg

from database import options
sys.path.insert(0, "/rds_rehearsal")
from history_transfer import merge_snapshot, unseal, validate


def private_read(path: Path, maximum: int) -> bytes:
    data = path.read_bytes()
    if len(data) > maximum:
        raise ValueError("Migration input exceeds bound")
    return data


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["dry-run", "commit", "verify"])
    parser.add_argument("--archive", required=True)
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--expected-sha256", required=True)
    args = parser.parse_args()

    key = private_read(Path(args.key_file), 32)
    if len(key) != 32:
        raise ValueError("Expected 256-bit migration key")
    snapshot = unseal(private_read(Path(args.archive), 32 * 1024 * 1024 + 128), key)
    manifest = validate(snapshot)
    if manifest["sha256"] != args.expected_sha256:
        raise ValueError("Source digest mismatch")

    with psycopg.connect(**options(os.environ)) as conn:
        if args.operation == "verify":
            report = merge_snapshot(conn, snapshot, dry_run=True)
            if any(report[name] for name in ("inserted_users", "inserted_identities", "inserted_rows")):
                raise ValueError("Destination verification found missing source data")
        else:
            report = merge_snapshot(conn, snapshot, dry_run=args.operation == "dry-run")

    print(json.dumps({
        "operation": args.operation,
        "users": manifest["users"],
        "rows": manifest["rows"],
        "sha256": manifest["sha256"],
        "inserted_users": report["inserted_users"],
        "inserted_identities": report["inserted_identities"],
        "inserted_rows": report["inserted_rows"],
        "existing_exact_rows": report["existing_exact_rows"],
        "target_users": report["target_users"],
        "target_identities": report["target_identities"],
        "target_rows": report["target_rows"],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print("ERROR: live history migration stopped (" + type(error).__name__ + "); private values omitted")
        raise SystemExit(1) from None
