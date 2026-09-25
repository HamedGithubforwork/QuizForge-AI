"""Bounded encrypted application-data backups; restore only into a fresh host.

Schema/roles are rebuilt from reviewed SQL, then compared before any import.
This deliberately does not copy PostgreSQL credentials, Cognito secrets, or PDF
work files. It is not a physical database backup or point-in-time recovery tool.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import time

import boto3
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import psycopg
from psycopg import sql


MAGIC = b"QFLB1\x00"
FORMAT = "quizforge-lightsail-data-v1"
MAX_BYTES = 32 * 1024 * 1024
MAX_ARCHIVE_BYTES = MAX_BYTES + len(MAGIC) + 12 + 16
MAX_ROWS = 10000
TABLES = (
    "app.users", "app.user_identities", "app.quiz_history",
    "app.identity_challenges", "billing.generation_policy", "billing.generation_usage",
    "billing.generation_reservations",
)
ROLES = ("quizforge_app", "quizforge_identity", "quizforge_generation")


def private_write(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as file:
        file.write(data)


def private_read(path, maximum):
    candidate = Path(path)
    descriptor = os.open(candidate, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as file:
        info = os.fstat(file.fileno())
        credentials_directory = os.environ.get("CREDENTIALS_DIRECTORY")
        systemd_credential = False
        if credentials_directory:
            root = Path(credentials_directory)
            systemd_credential = (
                root.is_absolute()
                and candidate.is_absolute()
                and candidate.parent == root
            )
        bad_mode = (
            info.st_mode & 0o022
            if systemd_credential
            else info.st_mode & 0o077
        )
        if not stat.S_ISREG(info.st_mode) or bad_mode or info.st_size > maximum:
            raise ValueError("Input must be a private bounded regular file")
        return file.read(maximum + 1)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def identifier(table):
    return sql.Identifier(*table.split("."))


def connection_options(env, restore=False):
    expected = "restore-db.quizforge.internal" if restore else "db.quizforge.internal"
    hostaddr = env.get("PGHOSTADDR")
    if (env.get("PGHOST") != expected or env.get("PGDATABASE") != "quizforge"
            or env.get("PGUSER") != "quizforge_owner" or env.get("PGPORT", "5432") != "5432"
            or (hostaddr is not None and hostaddr != "127.0.0.1")
            or not env.get("PGPASSWORD") or not Path(env.get("PGSSLROOTCERT", "")).is_file()):
        raise ValueError("Expected the explicit private database and verified TLS credentials")
    result = dict(host=expected, port=5432, dbname="quizforge", user="quizforge_owner",
                  password=env["PGPASSWORD"], sslmode="verify-full", sslrootcert=env["PGSSLROOTCERT"],
                  connect_timeout=10, autocommit=True,
                  options="-c statement_timeout=30000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000")
    if hostaddr is not None:
        result["hostaddr"] = hostaddr
    return result


def schema_state(conn):
    """Fingerprint structures AND security. Unknown tables require a format review."""
    relations = conn.execute("""SELECT n.nspname||'.'||c.relname, c.relkind,
        c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner), c.relacl::text
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema')
          AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
          AND c.relkind IN ('r','p','v','m','f','S') ORDER BY 1""").fetchall()
    if ([row[0] for row in relations] != sorted(TABLES)
            or any(row[1] != "r" for row in relations)):
        raise ValueError("Database tables differ from the reviewed backup scope")
    queries = {
        "columns": """SELECT table_schema,table_name,column_name,ordinal_position,data_type,
            udt_name,is_nullable,column_default,character_maximum_length,numeric_precision,
            numeric_scale,is_identity,is_generated,generation_expression,collation_name
            FROM information_schema.columns WHERE table_schema IN ('app','billing')
            ORDER BY table_schema,table_name,ordinal_position""",
        "constraints": """SELECT conrelid::regclass::text,conname,pg_get_constraintdef(oid)
            FROM pg_constraint WHERE connamespace IN ('app'::regnamespace,'billing'::regnamespace)
            ORDER BY 1,2""",
        "indexes": """SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes
            WHERE schemaname IN ('app','billing') ORDER BY 1,2,3""",
        "policies": """SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
            FROM pg_policies WHERE schemaname IN ('app','billing') ORDER BY 1,2,3""",
        "schemas": """SELECT nspname,pg_get_userbyid(nspowner),nspacl::text FROM pg_namespace
            WHERE nspname IN ('app','billing','public') ORDER BY 1""",
        "functions": """SELECT p.oid::regprocedure::text,pg_get_functiondef(p.oid),
            pg_get_userbyid(p.proowner),p.proacl::text FROM pg_proc p
            JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('app','billing')
            ORDER BY 1""",
        "column_grants": """SELECT grantee,table_schema,table_name,column_name,privilege_type,is_grantable
            FROM information_schema.column_privileges WHERE table_schema IN ('app','billing')
            ORDER BY 1,2,3,4,5""",
        "roles": """SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,
            rolreplication,rolbypassrls,rolconfig FROM pg_roles
            WHERE rolname IN ('quizforge_app','quizforge_identity','quizforge_generation') ORDER BY 1""",
        "memberships": """SELECT pg_get_userbyid(roleid),pg_get_userbyid(member),admin_option
            FROM pg_auth_members WHERE pg_get_userbyid(member) IN
            ('quizforge_app','quizforge_identity','quizforge_generation') ORDER BY 1,2""",
        "triggers": """SELECT tgrelid::regclass::text,tgname,pg_get_triggerdef(oid),tgenabled
            FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN
            (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname IN ('app','billing')) ORDER BY 1,2""",
    }
    result = {name: conn.execute(query).fetchall() for name, query in queries.items()}
    result["relations"] = relations
    if (len(result["roles"]) != 3 or result["memberships"]
            or any(any(row[i] for i in (1, 2, 3, 4, 6, 7)) for row in result["roles"])):
        raise ValueError("Runtime role privilege boundary differs from the reviewed schema")
    return digest(result)


def read_rows(conn):
    rows = {}
    used = 0
    for table in TABLES:
        # PostgreSQL emits exact numeric and timestamp JSON; never round via Python floats.
        query = sql.SQL("""SELECT CASE WHEN octet_length(j) <= %s THEN j END FROM
            (SELECT row_to_json(t)::text AS j FROM {} t) s ORDER BY j COLLATE "C" LIMIT %s""").format(identifier(table))
        with conn.cursor(name="backup_" + table.replace(".", "_")) as cursor:
            cursor.itersize = 1
            cursor.execute(query, (MAX_BYTES, MAX_ROWS + 1))
            values = []
            for row in cursor:
                value = row[0]
                if value is None:
                    raise ValueError("Backup row exceeds size limit")
                used += len(value.encode())
                if used > MAX_BYTES or len(values) >= MAX_ROWS:
                    raise ValueError("Backup exceeds reviewed row or memory bound")
                values.append(value)
        rows[table] = values
    return rows


def validate(snapshot):
    if (not isinstance(snapshot, dict) or set(snapshot) != {"format", "created_at", "schema", "tables", "sha256"}
            or snapshot["format"] != FORMAT or not re.fullmatch(r"[a-f0-9]{64}", snapshot["schema"])
            or set(snapshot["tables"]) != set(TABLES)):
        raise ValueError("Invalid backup format")
    datetime.fromisoformat(snapshot["created_at"])
    total = 0
    for table in TABLES:
        rows = snapshot["tables"][table]
        if not isinstance(rows, list) or len(rows) > MAX_ROWS:
            raise ValueError("Invalid backup row count")
        for row in rows:
            if not isinstance(row, str) or not isinstance(json.loads(row), dict):
                raise ValueError("Invalid backup record")
            total += len(row.encode())
        if rows != sorted(rows):
            raise ValueError("Noncanonical backup order")
    if total > MAX_BYTES or len(canonical(snapshot)) > MAX_BYTES:
        raise ValueError("Backup exceeds memory limit")
    payload = {k: v for k, v in snapshot.items() if k != "sha256"}
    if digest(payload) != snapshot["sha256"]:
        raise ValueError("Backup content digest mismatch")
    return {"sha256": snapshot["sha256"], "created_at": snapshot["created_at"],
            "rows": {t: len(snapshot["tables"][t]) for t in TABLES}}


def export_snapshot(conn):
    with conn.transaction():
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        conn.execute("SET LOCAL timezone='UTC'")
        conn.execute("SET LOCAL search_path=pg_catalog")
        # Like pg_dump, fail instead of silently backing up only rows visible
        # through an accidentally restricted backup role or FORCE RLS policy.
        conn.execute("SET LOCAL row_security=off")
        snapshot = {"format": FORMAT, "created_at": datetime.now(timezone.utc).isoformat(),
                    "schema": schema_state(conn), "tables": read_rows(conn)}
    snapshot["sha256"] = digest(snapshot)
    validate(snapshot)
    return snapshot


def seal(snapshot, key):
    validate(snapshot)
    if len(key) != 32:
        raise ValueError("Expected a separate 256-bit backup key")
    nonce = secrets.token_bytes(12)
    return MAGIC + nonce + AESGCM(key).encrypt(nonce, canonical(snapshot), MAGIC)


def unseal(archive, key):
    if len(key) != 32 or not archive.startswith(MAGIC) or not 34 < len(archive) <= MAX_ARCHIVE_BYTES:
        raise ValueError("Invalid encrypted backup")
    nonce = archive[len(MAGIC):len(MAGIC) + 12]
    snapshot = json.loads(AESGCM(key).decrypt(nonce, archive[len(MAGIC) + 12:], MAGIC))
    validate(snapshot)
    return snapshot


def restore_snapshot(conn, snapshot, commit=False):
    """All inserts, reconciliation and recovery interlocks share one transaction."""
    validate(snapshot)
    with conn.transaction():
        conn.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        conn.execute("SET LOCAL timezone='UTC'")
        conn.execute("SET LOCAL search_path=pg_catalog")
        conn.execute("SET LOCAL row_security=off")
        # Keep writers and concurrent restores out until all reconciliation completes.
        conn.execute(sql.SQL("LOCK TABLE {} IN ACCESS EXCLUSIVE MODE").format(
            sql.SQL(",").join(identifier(t) for t in TABLES)))
        if schema_state(conn) != snapshot["schema"]:
            raise ValueError("Destination schema/security fingerprint differs")
        existing = read_rows(conn)
        if any(existing[t] for t in TABLES if t != "billing.generation_policy"):
            raise ValueError("Restore destination contains application data")
        if ([json.loads(row) for row in existing["billing.generation_policy"]] != [{
                "singleton": True, "enabled": False, "daily_requests": 0, "monthly_requests": 0,
                "monthly_nano_usd": 0, "pricing_key": "", "pricing_valid_until": "1970-01-01"}]):
            raise ValueError("Restore destination is not the disabled fresh bootstrap")
        conn.execute("DELETE FROM billing.generation_policy")
        for table in TABLES:
            query = sql.SQL("INSERT INTO {} SELECT * FROM json_populate_record(NULL::{}, %s::json)").format(
                identifier(table), identifier(table))
            with conn.cursor() as cursor:
                cursor.executemany(query, [(row,) for row in snapshot["tables"][table]])
        if read_rows(conn) != snapshot["tables"]:
            raise ValueError("Restored content failed complete reconciliation")
        # Old proof nonces must not be usable after a rollback; spending needs an
        # explicit operator re-enable AFTER account recovery and canary checks.
        conn.execute("DELETE FROM app.identity_challenges")
        conn.execute("UPDATE billing.generation_policy SET enabled=false")
        report = {"dry_run": not commit, "reconciled": True,
                  "model_spending_enabled": False, "identity_challenges_invalidated": True,
                  **validate(snapshot)}
        if not commit:
            raise psycopg.Rollback()
    return report


def validate_bucket(bucket, account):
    if not re.fullmatch(r"[0-9]{12}", account) or bucket != "quizforge-production-backups-" + account:
        raise ValueError("Expected the reviewed backup bucket and owner")


def upload_archive(client, bucket, account, archive):
    validate_bucket(bucket, account)
    if len(archive) > MAX_ARCHIVE_BYTES or not archive.startswith(MAGIC):
        raise ValueError("Only bounded encrypted backups may leave the host")
    if client.get_bucket_versioning(Bucket=bucket, ExpectedBucketOwner=account).get("Status") != "Enabled":
        raise ValueError("Backup bucket versioning must be enabled before upload")
    sha = hashlib.sha256(archive).hexdigest()
    key = "lightsail/" + sha + ".qflb"
    response = client.put_object(Bucket=bucket, Key=key, Body=archive,
        ExpectedBucketOwner=account, IfNoneMatch="*", ServerSideEncryption="AES256",
        ChecksumSHA256=base64.b64encode(bytes.fromhex(sha)).decode(), ContentType="application/octet-stream")
    version = response.get("VersionId")
    if not version or version == "null":
        raise ValueError("Backup bucket versioning is required; upload is not accepted as a recovery point")
    return {"object_key": key, "version_id": version, "ciphertext_sha256": sha}


def download_archive(client, bucket, account, key, version):
    validate_bucket(bucket, account)
    match = re.fullmatch(r"lightsail/([a-f0-9]{64})\.qflb", key)
    if not match or not version or version == "null":
        raise ValueError("Restore requires an exact content address and S3 version")
    response = client.get_object(Bucket=bucket, Key=key, VersionId=version, ExpectedBucketOwner=account)
    body = response["Body"]
    try:
        if response["ContentLength"] > MAX_ARCHIVE_BYTES or response.get("VersionId") != version:
            raise ValueError("Backup size or version mismatch")
        archive = body.read(MAX_ARCHIVE_BYTES + 1)
    finally:
        body.close()
    if len(archive) > MAX_ARCHIVE_BYTES or hashlib.sha256(archive).hexdigest() != match[1]:
        raise ValueError("Backup ciphertext digest mismatch")
    return archive


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("generate-key", "export", "inspect", "restore", "upload", "download"))
    parser.add_argument("--key-file")
    parser.add_argument("--archive")
    parser.add_argument("--commit", action="store_true")
    parser.add_argument("--expected-sha256")
    parser.add_argument("--bucket")
    parser.add_argument("--account")
    parser.add_argument("--object-key")
    parser.add_argument("--version-id")
    args = parser.parse_args(argv)
    if (args.commit or args.expected_sha256) and args.operation != "restore":
        raise ValueError("Commit and expected digest apply only to restore")
    if args.operation == "generate-key":
        if not args.key_file or args.archive:
            raise ValueError("Provide a new private backup key path")
        private_write(args.key_file, secrets.token_bytes(32))
        print("PASS: separate private backup key created")
        return
    if not args.archive:
        raise ValueError("A private archive path is required")
    if args.operation in ("upload", "download"):
        validate_bucket(args.bucket or "", args.account or "")
        client = boto3.client("s3", region_name="ca-central-1")
        if args.operation == "download":
            archive = download_archive(client, args.bucket, args.account, args.object_key or "", args.version_id)
            private_write(args.archive, archive)
            print("PASS: exact encrypted backup version downloaded")
        else:
            # Authenticate before treating an upload as a valid backup.
            key = private_read(args.key_file, 32)
            archive = private_read(args.archive, MAX_ARCHIVE_BYTES)
            unseal(archive, key)
            print(json.dumps(upload_archive(client, args.bucket, args.account, archive), sort_keys=True))
        return
    key = private_read(args.key_file, 32)
    started = time.monotonic()
    if args.operation == "export":
        with psycopg.connect(**connection_options(os.environ)) as conn:
            snapshot = export_snapshot(conn)
        private_write(args.archive, seal(snapshot, key))
        report = validate(snapshot)
    else:
        snapshot = unseal(private_read(args.archive, MAX_ARCHIVE_BYTES), key)
        report = validate(snapshot)
        if args.operation == "restore":
            if args.commit and args.expected_sha256 != snapshot["sha256"]:
                raise ValueError("Committed restore requires the independently retained export digest")
            with psycopg.connect(**connection_options(os.environ, restore=True)) as conn:
                report = restore_snapshot(conn, snapshot, args.commit)
    print(json.dumps({"operation": args.operation, "seconds": round(time.monotonic() - started, 3), **report}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("ERROR: backup/recovery stopped (" + type(error).__name__ + "); data and credentials omitted", file=sys.stderr)
        raise SystemExit(1) from None
