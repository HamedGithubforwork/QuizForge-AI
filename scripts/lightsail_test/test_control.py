"""Failure-path tests for billable-resource ownership and independent cleanup."""
from datetime import datetime, timedelta, timezone
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

import control
import policy

ACCOUNT = '123456789012'
NAME = 'qf-capacity-1234-1'
INSTANCE = {'name': NAME, 'tags': [{'key': 'Purpose', 'value': policy.PURPOSE},
                                {'key': 'TestId', 'value': '1234-1'}]}


class Boundaries(unittest.TestCase):
    def test_identifiers_cannot_target_production_or_inject_shell(self):
        for value in ('production', '../1234-1', '1234-1;id', '0-1', '1-0', '1-1\n', '-1-1'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                policy.test_name(value)
        self.assertEqual(policy.test_name('1234-1'), NAME)

    def test_session_policies_fit_sts_and_inspect_has_no_writes(self):
        for operation in ('inspect', 'run', 'cleanup'):
            document = policy.session_policy(ACCOUNT, operation)
            self.assertLessEqual(len(json.dumps(document, separators=(',', ':'))), 2048)
            actions = [a for s in document['Statement'] for a in s['Action']]
            self.assertFalse(any(a.startswith(('route53:', 'cognito-idp:', 'bedrock:', 'rds:')) for a in actions))
            if operation == 'inspect':
                self.assertTrue(all(a.split(':')[1].startswith(('Get', 'List')) for a in actions))
            if operation == 'cleanup':
                self.assertNotIn('lightsail:CreateInstances', actions)
            self.assertNotIn('scheduler:DeleteSchedule', actions)
            self.assertNotIn('iam:CreateRole', actions)

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
