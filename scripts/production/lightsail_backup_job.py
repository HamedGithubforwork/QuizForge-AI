"""Explicit backup/health/recovery commands. Installing these files starts nothing."""
import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

import boto3
from botocore.config import Config
import psycopg

import lightsail_backup as backup

RECEIPT_FORMAT = 'quizforge-backup-receipt-v1'
STATE_FORMAT = 'quizforge-backup-job-v1'
MAX_METADATA = 8192
MAX_AGE_SECONDS = 26 * 3600
MAX_RUNNING_SECONDS = 15 * 60
NAMESPACE = 'QuizForge/Backup'
DIMENSIONS = [{'Name': 'Deployment', 'Value': 'production-lightsail'}]
MAIN_STAGE = 'startup'


def utcnow():
    return datetime.now(timezone.utc)


def timestamp(value):
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None or parsed.utcoffset().total_seconds() != 0:
        raise ValueError('Backup timestamps require UTC')
    return parsed


def private_directory(directory):
    root = Path(directory)
    if not root.is_absolute() or root.is_symlink():
        raise ValueError('An absolute private state directory is required')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = root.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError('State directory must be private and owned by the job user')
    return root


def write_state(root, value):
    raw = backup.canonical(value)
    if len(raw) > MAX_METADATA:
        raise ValueError('Backup status exceeds its bound')
    name = None
    try:
        with tempfile.NamedTemporaryFile(dir=root, prefix='status-', delete=False) as file:
            name = file.name
            file.write(raw)
            file.flush()
            os.fsync(file.fileno())
        os.replace(name, root / 'status.json')
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


def read_state(root):
    try:
        value = json.loads(backup.private_read(root / 'status.json', MAX_METADATA))
    except FileNotFoundError:
        return {'format': STATE_FORMAT, 'last_attempt': None, 'last_success': None}
    if not isinstance(value, dict) or set(value) != {'format', 'last_attempt', 'last_success'} or value['format'] != STATE_FORMAT:
        raise ValueError('Invalid backup status')
    return value


@contextmanager
def job_lock(root):
    descriptor = os.open(root / 'job.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise ValueError('Backup lock must be private')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def receipt_mac(payload, key):
    if len(key) != 32:
        raise ValueError('Expected the separate backup key')
    signing_key = hmac.digest(key, b'quizforge/backup-receipt-key/v1', 'sha256')
    return hmac.new(signing_key, backup.canonical(payload), 'sha256').hexdigest()


def verify_receipt(raw, key, bucket, account):
    backup.validate_bucket(bucket, account)
    if len(raw) > MAX_METADATA:
        raise ValueError('Receipt exceeds its bound')
    receipt = json.loads(raw)
    if not isinstance(receipt, dict) or set(receipt) != {'payload', 'hmac_sha256'}:
        raise ValueError('Invalid receipt envelope')
    payload = receipt['payload']
    if not isinstance(receipt['hmac_sha256'], str) or not hmac.compare_digest(receipt['hmac_sha256'], receipt_mac(payload, key)):
        raise ValueError('Receipt authentication failed')
    validate_receipt_payload(payload, bucket, account)
    return payload


def validate_receipt_payload(payload, bucket, account):
    backup.validate_bucket(bucket, account)
    fields = {'format', 'bucket', 'account', 'object_key', 'version_id', 'ciphertext_sha256', 'content_sha256', 'created_at'}
    if (not isinstance(payload, dict) or set(payload) != fields or payload['format'] != RECEIPT_FORMAT
            or payload['bucket'] != bucket or payload['account'] != account
            or not all(isinstance(payload[name], str) and re.fullmatch(r'[a-f0-9]{64}', payload[name])
                       for name in ('ciphertext_sha256', 'content_sha256'))
            or payload['object_key'] != 'lightsail/' + payload['ciphertext_sha256'] + '.qflb'
            or not isinstance(payload['version_id'], str) or not 1 <= len(payload['version_id']) <= 1024
            or payload['version_id'] == 'null'):
        raise ValueError('Invalid backup receipt')
    timestamp(payload['created_at'])


def publish_receipt(client, snapshot, uploaded, key, bucket, account):
    payload = {'format': RECEIPT_FORMAT, 'bucket': bucket, 'account': account,
               'created_at': snapshot['created_at'], 'content_sha256': snapshot['sha256'], **uploaded}
    raw = backup.canonical({'payload': payload, 'hmac_sha256': receipt_mac(payload, key)})
    verify_receipt(raw, key, bucket, account)
    object_key = 'receipts/' + uploaded['ciphertext_sha256'] + '.json'
    result = client.put_object(Bucket=bucket, Key=object_key, Body=raw, ExpectedBucketOwner=account,
        IfNoneMatch='*', ServerSideEncryption='AES256', ContentType='application/json',
        ChecksumSHA256=base64.b64encode(hashlib.sha256(raw).digest()).decode())
    version = result.get('VersionId')
    if not isinstance(version, str) or not version or version == 'null':
        raise ValueError('Receipt has no retained version; backup is not complete')
    return {'object_key': object_key, 'version_id': version, 'payload': payload}


def run_backup(directory, key, exporter, client, bucket, account, now=utcnow):
    """Hold one local job lock; a receipt upload must finish before success is recorded."""
    backup.validate_bucket(bucket, account)
    if len(key) != 32:
        raise ValueError('Expected the separate backup key')
    root = private_directory(directory)
    with job_lock(root):
        state = read_state(root)
        state['last_attempt'] = {'started_at': now().isoformat(), 'outcome': 'running'}
        write_state(root, state)
        stage = 'export'
        try:
            snapshot = exporter()
            stage = 'timestamp'
            age = (now() - timestamp(snapshot['created_at'])).total_seconds()
            if not -300 <= age <= MAX_RUNNING_SECONDS:
                raise ValueError('Export timestamp is outside this backup attempt')
            stage = 'seal'
            archive = backup.seal(snapshot, key)
            stage = 'archive_upload'
            uploaded = backup.upload_archive(client, bucket, account, archive)
            stage = 'receipt_upload'
            receipt = publish_receipt(client, snapshot, uploaded, key, bucket, account)
            stage = 'record_success'
            state['last_success'] = {'completed_at': now().isoformat(), 'receipt': receipt}
            state['last_attempt']['outcome'] = 'succeeded'
            write_state(root, state)
        except Exception:
            # Fixed stage names only; never print data, keys, credentials or exception text.
            print('QF_BACKUP_FAILED_STAGE=' + stage, file=sys.stderr, flush=True)
            # Never replace the previous recovery point with a partial upload.
            previous = read_state(root)
            previous['last_attempt']['outcome'] = 'failed'
            write_state(root, previous)
            raise
    return receipt


def health_status(directory, now=utcnow):
    """No database, decryption key or S3-read permission is needed for health publication."""
    try:
        state = read_state(private_directory(directory))
        attempt, success = state['last_attempt'], state['last_success']
        if (not isinstance(attempt, dict) or set(attempt) != {'started_at', 'outcome'}
                or not isinstance(success, dict) or set(success) != {'completed_at', 'receipt'}
                or attempt['outcome'] not in ('running', 'succeeded')):
            return False
        receipt = success['receipt']
        if not isinstance(receipt, dict) or set(receipt) != {'object_key', 'version_id', 'payload'}:
            return False
        payload = receipt['payload']
        validate_receipt_payload(payload, payload['bucket'], payload['account'])
        if (receipt['object_key'] != 'receipts/' + payload['ciphertext_sha256'] + '.json'
                or not isinstance(receipt['version_id'], str) or not 1 <= len(receipt['version_id']) <= 1024
                or receipt['version_id'] == 'null'):
            return False
        current = now()
        created = timestamp(payload['created_at'])
        completed = timestamp(success['completed_at'])
        age = (current - created).total_seconds()
        elapsed = (current - timestamp(attempt['started_at'])).total_seconds()
        return (-300 <= age <= MAX_AGE_SECONDS and elapsed >= -300
                and (current - completed).total_seconds() >= -300
                and (completed - created).total_seconds() >= -300
                and (attempt['outcome'] != 'running' or elapsed <= MAX_RUNNING_SECONDS))
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return False


def publish_health(client, fresh):
    client.put_metric_data(Namespace=NAMESPACE, MetricData=[{
        'MetricName': 'BackupFresh', 'Dimensions': DIMENSIONS, 'Value': int(fresh), 'Unit': 'Count',
    }])


def fetch_backup(client, key, bucket, account, receipt_key, receipt_version):
    """Recover using only an off-server receipt/version and the separately recovered key."""
    backup.validate_bucket(bucket, account)
    match = re.fullmatch(r'receipts/([a-f0-9]{64})\.json', receipt_key)
    if not match or not receipt_version or receipt_version == 'null':
        raise ValueError('An exact receipt key and version are required')
    response = client.get_object(Bucket=bucket, Key=receipt_key, VersionId=receipt_version, ExpectedBucketOwner=account)
    body = response['Body']
    try:
        if response['ContentLength'] > MAX_METADATA or response.get('VersionId') != receipt_version:
            raise ValueError('Receipt size or version mismatch')
        raw = body.read(MAX_METADATA + 1)
    finally:
        body.close()
    receipt = verify_receipt(raw, key, bucket, account)
    if receipt['ciphertext_sha256'] != match[1]:
        raise ValueError('Receipt content address mismatch')
    archive = backup.download_archive(client, bucket, account, receipt['object_key'], receipt['version_id'])
    snapshot = backup.unseal(archive, key)
    if snapshot['sha256'] != receipt['content_sha256'] or snapshot['created_at'] != receipt['created_at']:
        raise ValueError('Receipt does not describe the authenticated archive')
    return archive, raw, receipt


def aws_client(service):
    # Explicit bounded retries/timeouts; no custom endpoint or insecure TLS option.
    return boto3.client(service, region_name='ca-central-1', config=Config(
        ignore_configured_endpoint_urls=True, connect_timeout=5, read_timeout=20, retries={'mode': 'standard', 'total_max_attempts': 3}))


def main(argv=None):
    global MAIN_STAGE
    MAIN_STAGE = 'parse_arguments'
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('run', 'health', 'fetch'))
    parser.add_argument('--state-dir', default='/var/lib/quizforge-backup')
    parser.add_argument('--failed', action='store_true', help='Record a failed backup service before publishing health')
    parser.add_argument('--key-file')
    parser.add_argument('--bucket', default=os.environ.get('BACKUP_BUCKET', ''))
    parser.add_argument('--account', default=os.environ.get('BACKUP_ACCOUNT', ''))
    parser.add_argument('--receipt-key')
    parser.add_argument('--receipt-version')
    parser.add_argument('--archive')
    parser.add_argument('--receipt-file')
    args = parser.parse_args(argv)
    if args.failed and args.operation != 'health':
        raise ValueError('Failure marking is only available for health reporting')
    if args.operation == 'health':
        MAIN_STAGE = 'health'
        if args.failed:
            root = private_directory(args.state_dir)
            with job_lock(root):
                state = read_state(root)
                state['last_attempt'] = {'started_at': utcnow().isoformat(), 'outcome': 'failed'}
                write_state(root, state)
        fresh = health_status(args.state_dir)
        publish_health(aws_client('cloudwatch'), fresh)
        print(json.dumps({'backup_fresh': fresh}))
        return 0 if fresh else 1
    MAIN_STAGE = 'bucket_validation'
    backup.validate_bucket(args.bucket, args.account)
    MAIN_STAGE = 'key_read'
    key = backup.private_read(args.key_file, 32)
    if args.operation == 'run':
        MAIN_STAGE = 'run_backup'
        def export():
            with psycopg.connect(**backup.connection_options(os.environ)) as conn:
                return backup.export_snapshot(conn)
        run_backup(args.state_dir, key, export, aws_client('s3'), args.bucket, args.account)
        print('PASS: encrypted archive and authenticated recovery receipt stored off-server')
    else:
        MAIN_STAGE = 'fetch_backup'
        if not args.archive or not args.receipt_file or args.archive == args.receipt_file:
            raise ValueError('Provide separate new private archive and receipt paths')
        archive, raw, receipt = fetch_backup(aws_client('s3'), key, args.bucket, args.account,
                                            args.receipt_key or '', args.receipt_version)
        backup.private_write(args.archive, archive)
        backup.private_write(args.receipt_file, raw)
        print(json.dumps({'content_sha256': receipt['content_sha256'], 'created_at': receipt['created_at']}))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print('QF_BACKUP_MAIN_FAILED_STAGE=' + MAIN_STAGE, file=sys.stderr, flush=True)
        print('ERROR: backup operation stopped (' + type(error).__name__ + '); data and credentials omitted', file=sys.stderr)
        raise SystemExit(1) from None
