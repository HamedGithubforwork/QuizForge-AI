"""Synthetic S3 HTTP transport; no AWS credentials, resources or live data."""
import base64
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, unquote, urlsplit
from xml.sax.saxutils import escape

import boto3
from botocore.config import Config

import lightsail_backup as backup
import lightsail_backup_job as job

ACCOUNT = '123456789012'
BUCKET = 'quizforge-production-backups-' + ACCOUNT
NOW = datetime(2026, 9, 21, 4, 15, tzinfo=timezone.utc)


def snapshot():
    value = {'format': backup.FORMAT, 'created_at': NOW.isoformat(), 'schema': 'a' * 64,
             'tables': {table: [] for table in backup.TABLES}}
    value['sha256'] = backup.digest(value)
    return value


class SyntheticS3:
    """A deliberately limited protocol fixture, not a claim about AWS IAM behavior."""
    def __init__(self):
        self.objects = {}
        self.requests = []
        self.fail_receipt = False
        fixture = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def reply(self, status, raw, version=None, content_type='application/xml'):
                self.send_response(status)
                self.send_header('Content-Length', str(len(raw)))
                self.send_header('Content-Type', content_type)
                if version: self.send_header('x-amz-version-id', version)
                self.end_headers()
                self.wfile.write(raw)
            def parse(self):
                url = urlsplit(self.path)
                bucket, _, key = unquote(url.path).lstrip('/').partition('/')
                assert bucket == BUCKET
                assert self.headers['x-amz-expected-bucket-owner'] == ACCOUNT
                assert self.headers['Authorization'].startswith('AWS4-HMAC-SHA256 ')
                fixture.requests.append((self.command, key, dict(self.headers)))
                return key, parse_qs(url.query, keep_blank_values=True)
            def do_PUT(self):
                key, _ = self.parse()
                raw = self.rfile.read(int(self.headers['Content-Length']))
                assert self.headers['If-None-Match'] == '*'
                assert self.headers['x-amz-server-side-encryption'] == 'AES256'
                assert self.headers['x-amz-checksum-sha256'] == base64.b64encode(hashlib.sha256(raw).digest()).decode()
                if fixture.fail_receipt and key.startswith('receipts/'):
                    return self.reply(503, b'<Error><Code>ServiceUnavailable</Code></Error>')
                if key in fixture.objects:
                    return self.reply(412, b'<Error><Code>PreconditionFailed</Code></Error>')
                version = 'synthetic-' + str(len(fixture.objects) + 1)
                fixture.objects[key] = (version, raw)
                self.reply(200, b'', version)
            def do_GET(self):
                key, query = self.parse()
                if 'versioning' in query:
                    return self.reply(200, b'<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>')
                if 'versions' in query:
                    entries = ''.join('<Version><Key>' + escape(name) + '</Key><VersionId>' + version + '</VersionId></Version>'
                        for name, (version, raw) in fixture.objects.items() if name.startswith(query.get('prefix', [''])[0]))
                    return self.reply(200, ('<ListVersionsResult><IsTruncated>false</IsTruncated>' + entries + '</ListVersionsResult>').encode())
                if key not in fixture.objects or query.get('versionId') != [fixture.objects[key][0]]:
                    return self.reply(404, b'<Error><Code>NoSuchVersion</Code></Error>')
                version, raw = fixture.objects[key]
                self.reply(200, raw, version, 'application/octet-stream')
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = boto3.client('s3', region_name='ca-central-1', endpoint_url='http://127.0.0.1:' + str(self.server.server_port),
            aws_access_key_id='synthetic-access', aws_secret_access_key='synthetic-secret',
            config=Config(s3={'addressing_style': 'path'}, retries={'total_max_attempts': 1}, connect_timeout=2, read_timeout=2))
    def close(self):
        self.client.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


@contextmanager
def synthetic_s3():
    fixture = SyntheticS3()
    try:
        yield fixture
    finally:
        fixture.close()


class MainFailureStageTests(unittest.TestCase):
    def test_main_uses_only_fixed_safe_failure_stage_names(self):
        import inspect
        source = inspect.getsource(job.main)
        for name in ("parse_arguments", "health", "bucket_validation", "key_read", "run_backup", "fetch_backup"):
            self.assertIn("MAIN_STAGE = '" + name + "'", source)
        module_source = inspect.getsource(job)
        self.assertIn("QF_BACKUP_MAIN_FAILED_STAGE=", module_source)
        self.assertNotIn("QF_BACKUP_MAIN_FAILED_STAGE=' + str(error)", module_source)


class FailureStageTests(unittest.TestCase):
    def test_run_backup_uses_only_fixed_failure_stage_names(self):
        import inspect
        source = inspect.getsource(job.run_backup)
        for name in ("export", "timestamp", "seal", "archive_upload", "receipt_upload", "record_success"):
            self.assertIn("stage = '" + name + "'", source)
        self.assertIn("QF_BACKUP_FAILED_STAGE=", source)
        self.assertNotIn("str(error)", source)


class BackupAutomation(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / 'state'
        self.key = secrets.token_bytes(32)

    def run_backup(self, fixture, export=snapshot):
        return job.run_backup(self.root, self.key, export, fixture.client, BUCKET, ACCOUNT, now=lambda: NOW)

    def test_http_offserver_roundtrip_and_receipt_discovery_after_local_state_loss(self):
        with synthetic_s3() as fixture:
            self.run_backup(fixture)
            self.assertTrue(job.health_status(self.root, now=lambda: NOW))
            for file in self.root.iterdir(): file.unlink()
            self.root.rmdir()
            # Recovery starts with the off-server version listing, not a surviving host receipt.
            versions = fixture.client.list_object_versions(Bucket=BUCKET, Prefix='receipts/', ExpectedBucketOwner=ACCOUNT)['Versions']
            self.assertEqual(len(versions), 1)
            archive, raw, receipt = job.fetch_backup(fixture.client, self.key, BUCKET, ACCOUNT, versions[0]['Key'], versions[0]['VersionId'])
            self.assertEqual(backup.unseal(archive, self.key), snapshot())
            self.assertEqual(receipt['content_sha256'], snapshot()['sha256'])
            self.assertEqual(job.verify_receipt(raw, self.key, BUCKET, ACCOUNT), receipt)
            self.assertNotIn(b'"tables"', archive)
            self.assertNotIn(b'"tables"', raw)

    def test_receipt_upload_failure_preserves_previous_success_and_marks_unhealthy(self):
        with synthetic_s3() as fixture:
            self.run_backup(fixture)
            previous = job.read_state(self.root)['last_success']
            fixture.fail_receipt = True
            with self.assertRaises(Exception): self.run_backup(fixture)
            state = job.read_state(self.root)
            self.assertEqual(state['last_success'], previous)
            self.assertEqual(state['last_attempt']['outcome'], 'failed')
            self.assertFalse(job.health_status(self.root, now=lambda: NOW))
            self.assertEqual(len([key for key in fixture.objects if key.startswith('receipts/')]), 1)
            self.assertEqual(len([key for key in fixture.objects if key.startswith('lightsail/')]), 2)

    def test_database_failure_never_uploads_and_failed_service_marks_missing_key_errors(self):
        client = Mock()
        def unavailable(): raise RuntimeError('synthetic private SQL detail')
        with self.assertRaises(RuntimeError):
            job.run_backup(self.root, self.key, unavailable, client, BUCKET, ACCOUNT, now=lambda: NOW)
        client.put_object.assert_not_called()
        self.assertFalse(job.health_status(self.root, now=lambda: NOW))
        with patch.object(job, 'aws_client', return_value=client):
            self.assertEqual(job.main(['health', '--failed', '--state-dir', str(self.root)]), 1)
        self.assertEqual(client.put_metric_data.call_args.kwargs['MetricData'][0]['Value'], 0)

    def test_lock_prevents_concurrent_exports_without_replacing_status(self):
        root = job.private_directory(self.root)
        exporter = Mock()
        with job.job_lock(root), self.assertRaises(BlockingIOError):
            job.run_backup(root, self.key, exporter, Mock(), BUCKET, ACCOUNT, now=lambda: NOW)
        exporter.assert_not_called()
        self.assertFalse((root / 'status.json').exists())

    def test_freshness_checks_age_failure_future_clock_and_interrupted_job(self):
        with synthetic_s3() as fixture:
            self.run_backup(fixture)
        self.assertTrue(job.health_status(self.root, now=lambda: NOW + timedelta(hours=26)))
        self.assertFalse(job.health_status(self.root, now=lambda: NOW + timedelta(hours=26, seconds=1)))
        self.assertFalse(job.health_status(self.root, now=lambda: NOW - timedelta(minutes=6)))
        state = job.read_state(self.root)
        state['last_attempt']['outcome'] = 'running'
        job.write_state(self.root, state)
        self.assertTrue(job.health_status(self.root, now=lambda: NOW + timedelta(minutes=14)))
        self.assertFalse(job.health_status(self.root, now=lambda: NOW + timedelta(minutes=16)))
        valid = backup.canonical(state)
        for field in ('object_key', 'version_id', 'payload'):
            malformed = json.loads(valid)
            del malformed['last_success']['receipt'][field]
            job.write_state(self.root, malformed)
            self.assertFalse(job.health_status(self.root, now=lambda: NOW))
        malformed = json.loads(valid)
        malformed['last_success']['receipt']['version_id'] = 'null'
        job.write_state(self.root, malformed)
        self.assertFalse(job.health_status(self.root, now=lambda: NOW))
        (self.root / 'status.json').write_text('corrupt')
        self.assertFalse(job.health_status(self.root, now=lambda: NOW))

    def test_receipt_tampering_wrong_key_owner_and_address_fail_before_archive_read(self):
        with synthetic_s3() as fixture:
            locator = self.run_backup(fixture)
            args = (fixture.client, self.key, BUCKET, ACCOUNT, locator['object_key'], locator['version_id'])
            version, raw = fixture.objects[locator['object_key']]
            for corrupted in (raw[:-1], raw.replace(b'"content_sha256":"', b'"content_sha256":"b'), b'{}'):
                fixture.objects[locator['object_key']] = (version, corrupted)
                before = len(fixture.requests)
                with self.assertRaises(ValueError): job.fetch_backup(*args)
                self.assertEqual(len(fixture.requests), before + 1)
            fixture.objects[locator['object_key']] = (version, raw)
            with self.assertRaises(ValueError): job.fetch_backup(fixture.client, secrets.token_bytes(32), *args[2:])
            with self.assertRaises(ValueError): job.fetch_backup(fixture.client, self.key, BUCKET, '999999999999', *args[4:])
            payload = json.loads(raw)['payload']
            payload['content_sha256'] = 'b' * 64
            bad = backup.canonical({'payload': payload, 'hmac_sha256': job.receipt_mac(payload, self.key)})
            fixture.objects[locator['object_key']] = (version, bad)
            with self.assertRaisesRegex(ValueError, 'does not describe'): job.fetch_backup(*args)

    def test_stale_exports_and_unsafe_local_paths_fail_without_upload(self):
        value = snapshot()
        value['created_at'] = (NOW - timedelta(hours=2)).isoformat()
        client = Mock()
        with self.assertRaises(ValueError):
            job.run_backup(self.root, self.key, lambda: value, client, BUCKET, ACCOUNT, now=lambda: NOW)
        client.put_object.assert_not_called()
        link = Path(self.directory.name) / 'link'
        link.symlink_to(self.root)
        with self.assertRaises(ValueError): job.private_directory(link)
        self.root.chmod(0o755)
        with self.assertRaises(ValueError): job.private_directory(self.root)
        self.root.chmod(0o700)

    def test_sdk_ignores_custom_endpoints_and_bounds_transport_retries(self):
        with patch.dict('os.environ', {'AWS_ACCESS_KEY_ID': 'synthetic', 'AWS_SECRET_ACCESS_KEY': 'synthetic',
                                      'AWS_ENDPOINT_URL': 'http://untrusted.invalid'}):
            client = job.aws_client('s3')
            try:
                self.assertEqual(client.meta.endpoint_url, 'https://s3.ca-central-1.amazonaws.com')
                self.assertEqual(client.meta.config.retries['total_max_attempts'], 3)
                self.assertEqual(client.meta.config.read_timeout, 20)
            finally:
                client.close()

    def test_health_metric_has_fixed_namespace_and_no_user_data(self):
        client = Mock()
        job.publish_health(client, False)
        self.assertEqual(client.put_metric_data.call_args.kwargs, {'Namespace': 'QuizForge/Backup', 'MetricData': [{
            'MetricName': 'BackupFresh', 'Dimensions': [{'Name': 'Deployment', 'Value': 'production-lightsail'}],
            'Value': 0, 'Unit': 'Count',
        }]})


if __name__ == '__main__':
    unittest.main()
