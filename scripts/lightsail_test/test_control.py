"""Failure-path tests for billable-resource ownership and independent cleanup."""
from datetime import datetime, timedelta, timezone
import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import boto3
from botocore.exceptions import ClientError
from botocore.validate import validate_parameters
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (Encoding, PublicFormat,
                                                         SSHCertificateBuilder, SSHCertificateType, load_ssh_private_key)

import control
import policy

ACCOUNT = '123456789012'
NAME = 'qf-capacity-1234-1'
INSTANCE = {'name': NAME, 'tags': [{'key': 'Purpose', 'value': policy.PURPOSE},
                                {'key': 'TestId', 'value': '1234-1'}]}


class Boundaries(unittest.TestCase):
    def test_incomplete_aws_ssh_fields_are_waited_for_without_logging_secrets(self):
        client = MagicMock()
        complete = {'ipAddress': '203.0.113.1', 'instanceName': NAME, 'username': 'ubuntu',
                    'expiresAt': datetime.now(timezone.utc) + timedelta(hours=1),
                    'privateKey': 'private-value', 'certKey': 'cert-value',
                    'hostKeys': [{'algorithm': 'ssh-ed25519', 'publicKey': 'AAAA'}]}
        incomplete = {**complete, 'certKey': ''}
        client.get_instance_access_details.side_effect = [
            {'accessDetails': incomplete}, {'accessDetails': complete}]
        with patch.object(control.time, 'sleep'), patch('builtins.print') as printed:
            self.assertEqual(control.wait_ssh_details(client, INSTANCE), complete)
        self.assertEqual(client.get_instance_access_details.call_count, 2)
        self.assertNotIn('private-value', str(printed.call_args_list))
        self.assertNotIn('cert-value', str(printed.call_args_list))

    def test_missing_ssh_details_fail_closed_at_the_deadline(self):
        client = MagicMock()
        client.get_instance_access_details.return_value = {'accessDetails': {}}
        with self.assertRaisesRegex(RuntimeError, 'missing fields:.*certKey'):
            control.wait_ssh_details(client, INSTANCE, wait_seconds=0)
        client.get_instance_access_details.assert_called_once()

    def test_ssh_identity_mismatch_is_rejected_before_writing_credentials(self):
        access = {'ipAddress': '203.0.113.1', 'instanceName': NAME, 'username': 'root'}
        with tempfile.TemporaryDirectory() as tmp, patch.object(control, 'wait_ssh_details', return_value=access):
            with self.assertRaisesRegex(RuntimeError, 'Unexpected SSH account'):
                control.ssh_access(MagicMock(), {**INSTANCE, 'publicIpAddress': '203.0.113.1'}, Path(tmp), 'ssh-ed25519 AAAA')
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_signed_certificate_expiry_is_checked_when_api_expiry_is_absent(self):
        now = int(datetime.now(timezone.utc).timestamp())
        ca = Ed25519PrivateKey.generate()
        key = Ed25519PrivateKey.generate().public_key()
        def certificate(expiry, principal=b'ubuntu', kind=SSHCertificateType.USER):
            return (SSHCertificateBuilder().public_key(key).type(kind).valid_principals([principal])
                    .valid_after(now - 120).valid_before(expiry).sign(ca).public_bytes().decode())
        control.validate_ssh_certificate({'certKey': certificate(now + 3600)})
        control.validate_ssh_certificate({'certKey': certificate(now + 120)})
        for cert in (certificate(now - 1), certificate(now + 10),
                     certificate(now + 3600, b'root'), certificate(now + 3600, kind=SSHCertificateType.HOST)):
            with self.subTest(cert=cert[:25]), self.assertRaises(RuntimeError):
                control.validate_ssh_certificate({'certKey': cert})
        with self.assertRaisesRegex(RuntimeError, 'API credential lifetime'):
            control.validate_ssh_certificate({'certKey': certificate(now + 3600),
                                             'expiresAt': datetime.now(timezone.utc) + timedelta(seconds=10)})

    def test_each_connection_fetches_new_credentials_and_removes_private_files(self):
        access = {'ipAddress': '203.0.113.1', 'instanceName': NAME, 'username': 'ubuntu',
                  'privateKey': 'private-value', 'certKey': 'cert-value'}
        instance = {**INSTANCE, 'publicIpAddress': '203.0.113.1'}
        directories = []
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'RUNNER_TEMP': root}), \
             patch.object(control, 'wait_ssh_details', return_value=access) as fetch, \
             patch.object(control, 'validate_ssh_certificate') as validate:
            for failure in (False, True):
                try:
                    with control.ssh_connection(MagicMock(), instance, 'ssh-ed25519 AAAA') as (options, target):
                        directory = Path(options[1]).parent
                        directories.append(directory)
                        self.assertTrue((directory / 'identity').is_file())
                        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
                        if failure:
                            raise RuntimeError('connection failed')
                except RuntimeError as error:
                    self.assertEqual(str(error), 'connection failed')
                self.assertFalse(directory.exists())
            self.assertEqual(fetch.call_count, 2)
            self.assertEqual(validate.call_count, 2)
        self.assertNotEqual(*directories)

    def test_each_bootstrap_has_a_unique_key_matching_the_client_pin(self):
        script, public = control.host_bootstrap()
        other_script, other_public = control.host_bootstrap()
        self.assertNotEqual(public, other_public)
        self.assertNotEqual(script, other_script)
        encoded = script.split("printf '%s' '", 1)[1].split("'", 1)[0]
        private = load_ssh_private_key(base64.b64decode(encoded), password=None)
        actual = private.public_key().public_bytes(Encoding.OpenSSH, PublicFormat.OpenSSH).decode()
        self.assertEqual(actual, public)
        self.assertNotIn('__CAPACITY_HOST_KEY_BASE64__', script)
        self.assertIn('HostKeyAlgorithms ssh-ed25519', script)

    def test_client_pins_only_the_provisioned_key_and_keeps_strict_checking(self):
        _, public = control.host_bootstrap()
        access = {'ipAddress': '203.0.113.1', 'instanceName': NAME, 'username': 'ubuntu',
                  'privateKey': 'private-value', 'certKey': 'cert-value'}
        with tempfile.TemporaryDirectory() as tmp, patch.object(control, 'wait_ssh_details', return_value=access), \
             patch.object(control, 'validate_ssh_certificate'):
            options, target = control.ssh_access(MagicMock(),
                {**INSTANCE, 'publicIpAddress': '203.0.113.1'}, Path(tmp), public)
            self.assertEqual((Path(tmp) / 'known_hosts').read_text(), '203.0.113.1 ' + public + '\n')
            self.assertIn('StrictHostKeyChecking=yes', options)
            self.assertEqual(target, 'ubuntu@203.0.113.1')
            self.assertEqual((Path(tmp) / 'identity').read_text(), 'private-value\n')
            self.assertEqual((Path(tmp) / 'identity-cert.pub').read_text(), 'cert-value\n')
            for file in Path(tmp).iterdir():
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_ssh_readiness_reports_categories_without_echoing_stderr(self):
        for code, stderr, expected in (
            (0, b'', 'ready'),
            (1, b'', 'authenticated; bootstrap not ready'),
            (255, b'Load key /private/path: error in libcrypto\nprivate-secret', 'private key encoding rejected'),
            (255, b'Permission denied (publickey). private-secret', 'login rejected'),
            (255, b'Host key verification failed. private-secret', 'host identity rejected'),
            (255, b'private-secret', 'unclassified SSH failure'),
        ):
            with self.subTest(code=code, expected=expected):
                self.assertEqual(control.ssh_probe_status(control.subprocess.CompletedProcess([], code, stderr=stderr)), expected)

    def test_identifiers_cannot_target_production_or_inject_shell(self):
        for value in ('production', '../1234-1', '1234-1;id', '0-1', '1-0', '1-1\n', '-1-1'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                policy.test_name(value)
        self.assertEqual(policy.test_name('1234-1'), NAME)

    def test_session_policies_fit_sts_and_inspect_has_no_writes(self):
        for operation in ('inspect', 'run', 'cleanup'):
            document = policy.session_policy(ACCOUNT, operation, '12345678901234567890-12345')
            self.assertLessEqual(len(json.dumps(document, separators=(',', ':'))), 2048)
            actions = [a for s in document['Statement'] for a in s['Action']]
            self.assertFalse(any(a.startswith(('route53:', 'cognito-idp:', 'bedrock:', 'rds:')) for a in actions))
            if operation == 'inspect':
                self.assertTrue(all(a.split(':')[1].startswith(('Get', 'List')) for a in actions))
            if operation == 'cleanup':
                self.assertNotIn('lightsail:CreateInstances', actions)
            if operation != 'run':
                self.assertNotIn('lightsail:TagResource', actions)
            self.assertNotIn('scheduler:DeleteSchedule', actions)
            self.assertNotIn('iam:CreateRole', actions)

    def test_tagging_is_limited_to_instances_and_this_runs_three_tags(self):
        document = policy.session_policy(ACCOUNT, 'run', '1234-1')
        statement, = [s for s in document['Statement'] if 'lightsail:TagResource' in s['Action']]
        self.assertEqual(statement['Resource'], f'arn:aws:lightsail:ca-central-1:{ACCOUNT}:Instance/*')
        self.assertEqual(statement['Condition'], {
            'StringEquals': {'aws:RequestTag/Purpose': policy.PURPOSE, 'aws:RequestTag/TestId': '1234-1'},
            'ForAllValues:StringEquals': {'aws:TagKeys': ['Purpose', 'TestId', 'DeleteAfter']}})
        self.assertFalse(any('lightsail:UntagResource' in s['Action'] for s in document['Statement']))
        with self.assertRaises(ValueError):
            policy.session_policy(ACCOUNT, 'run')

    def test_price_ram_ipv4_and_size_are_not_silently_upgraded(self):
        good = {'bundleId': policy.BUNDLE, 'isActive': True, 'price': 12, 'cpuCount': 2,
                'ramSizeInGb': 2, 'diskSizeInGb': 60, 'publicIpv4AddressCount': 1,
                'supportedPlatforms': ['LINUX_UNIX']}
        self.assertEqual(control.check_bundle([good])['price'], 12)
        for key, value in [('price', 12.01), ('ramSizeInGb', 4), ('diskSizeInGb', 80),
                           ('publicIpv4AddressCount', 0), ('isActive', False)]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                control.check_bundle([{**good, key: value}])

    def test_schedule_matches_aws_api_shapes_and_fixed_utc_deadline(self):
        deadline = datetime(2026, 9, 20, 12, tzinfo=timezone.utc)
        request = control.schedule_request(NAME, ACCOUNT, deadline)
        session = boto3.session.Session()
        model = session._session.get_service_model('scheduler')
        validate_parameters(request, model.operation_model('CreateSchedule').input_shape)
        # The live Scheduler validator requires InstanceName, even though the
        # direct Lightsail API model accepts instanceName. Do not mistake a
        # direct boto3 schema check for the universal-target input contract.
        self.assertEqual(json.loads(request['Target']['Input']),
                         {'InstanceName': NAME, 'ForceDeleteAddOns': True})
        self.assertEqual(request['ScheduleExpression'], 'at(2026-09-20T12:00:00)')
        self.assertEqual(request['ActionAfterCompletion'], 'DELETE')

    def test_bad_schedule_readback_fails_closed(self):
        scheduler = MagicMock()
        scheduler.get_schedule.return_value = {'State': 'DISABLED'}
        with self.assertRaisesRegex(RuntimeError, 'read-back'):
            control.arm(scheduler, NAME, ACCOUNT, datetime.now(timezone.utc) + timedelta(hours=2))

    def test_schedule_validation_reports_reason_without_dumping_aws_response(self):
        scheduler = MagicMock()
        scheduler.create_schedule.side_effect = ClientError({'Error': {
            'Code': 'ValidationException', 'Message': 'Unsupported target\nparameter'},
            'UnexpectedPrivateField': 'must-not-be-logged'}, 'CreateSchedule')
        with self.assertRaises(RuntimeError) as raised:
            control.arm(scheduler, NAME, ACCOUNT, datetime.now(timezone.utc) + timedelta(hours=2))
        self.assertEqual(str(raised.exception),
                         'Cleanup schedule creation rejected: ValidationException: Unsupported target parameter')
        scheduler.get_schedule.assert_not_called()

    def test_launch_denial_is_diagnostic_but_access_credentials_stay_private(self):
        error = {'Error': {'Code': 'AccessDeniedException', 'Message': 'Launch restricted\nby account plan'},
                 'PrivateResponse': 'must-not-be-logged'}
        self.assertEqual(control.failure_summary(ClientError(error, 'CreateInstances')),
                         'CreateInstances: AccessDeniedException: Launch restricted by account plan')
        self.assertEqual(control.failure_summary(ClientError(error, 'GetInstanceAccessDetails')),
                         'GetInstanceAccessDetails: AccessDeniedException')

    def test_launch_validation_does_not_echo_encoded_bootstrap_key(self):
        secret = base64.b64encode(b'disposable private host identity' * 10).decode()
        error = ClientError({'Error': {'Code': 'InvalidInputException',
                                      'Message': 'Invalid userData ' + secret}}, 'CreateInstances')
        self.assertNotIn(secret, control.failure_summary(error))
        self.assertIn('[redacted]', control.failure_summary(error))

    def test_foreign_instance_is_never_deleted(self):
        client = MagicMock()
        for value in ({'name': NAME, 'tags': []}, {**INSTANCE, 'name': 'production'},
                      {'name': NAME, 'tags': [{'key': 'Purpose', 'value': policy.PURPOSE}]}):
            client.get_instance.return_value = {'instance': value}
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                control.cleanup_instance(client, NAME)
        client.delete_instance.assert_not_called()

    def test_missing_instance_does_not_disarm_scheduled_cleanup(self):
        client = MagicMock()
        client.get_instance.side_effect = ClientError({'Error': {'Code': 'NotFoundException'}}, 'GetInstance')
        result = control.cleanup_instance(client, NAME)
        self.assertTrue(result['instance_absent'] and result['schedule_retained'])
        client.delete_instance.assert_not_called()

    def test_deletion_must_be_confirmed_and_ambiguous_failure_stays_armed(self):
        client = MagicMock()
        client.get_instance.return_value = {'instance': INSTANCE}
        with self.assertRaisesRegex(RuntimeError, 'Deletion not confirmed'):
            control.cleanup_instance(client, NAME, wait_seconds=0)
        client.delete_instance.assert_called_once_with(instanceName=NAME, forceDeleteAddOns=True)

    def test_schedule_failure_prevents_creation_and_create_error_still_cleans(self):
        for where in ('schedule', 'create'):
            with self.subTest(where=where), tempfile.TemporaryDirectory() as tmp:
                old = os.getcwd()
                try:
                    os.chdir(tmp)
                    Path('capacity-build').mkdir()
                    payload = b'synthetic-test-image'
                    Path('capacity-build/capacity-image.tar.gz').write_bytes(payload)
                    Path('capacity-build/manifest.json').write_text(json.dumps({
                        'application_sha': policy.APP_SHA, 'harness_sha': policy.HARNESS_SHA,
                        'image_sha256': hashlib.sha256(payload).hexdigest()}))
                    ls, scheduler, iam, free = (MagicMock() for _ in range(4))
                    if where == 'create':
                        ls.create_instances.side_effect = RuntimeError('Ambiguous API failure')
                    response = MagicMock()
                    response.__enter__.return_value.read.return_value = b'8.8.8.8'
                    with patch.object(control, 'preflight', return_value={'checks': {'bundle': {'price': 12}, 'availability_zone': 'ca-central-1a'}}), \
                         patch.object(control, 'urlopen', return_value=response), \
                         patch.object(control, 'arm', side_effect=RuntimeError('Schedule failure') if where == 'schedule' else None), \
                         patch.object(control, 'cleanup_instance', return_value={'instance_absent': True, 'schedule_retained': True}) as cleanup, \
                         patch.object(control.signal, 'alarm'), patch('builtins.print'):
                        with self.assertRaises(RuntimeError):
                            control.run((ls, scheduler, iam, free), ACCOUNT, NAME)
                        cleanup.assert_called_once_with(ls, NAME)
                    report = json.loads(Path('lightsail-results/run.json').read_text())
                    self.assertEqual(report['cleanup_schedule_verified'], where == 'create')
                    self.assertEqual(report['instance_creation_attempted'], where == 'create')
                    self.assertEqual(ls.create_instances.call_count, int(where == 'create'))
                    if where == 'create':
                        args = ls.create_instances.call_args.kwargs
                        self.assertEqual(args['instanceNames'], [NAME])
                        self.assertEqual(args['bundleId'], policy.BUNDLE)
                        self.assertEqual(args['ipAddressType'], 'ipv4')
                        self.assertEqual(args['addOns'], [])
                finally:
                    os.chdir(old)


if __name__ == '__main__':
    unittest.main()
