import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts.production.lightsail import provision_native_client as registration
from scripts.production.lightsail.test_native_auth_readiness import FakeSTS, FakeCognito, POOL, WEB, NATIVE, NAME

POLICY = {'UserPoolId': POOL, 'ClientName': NAME, 'GenerateSecret': False}

class WritableCognito(FakeCognito):
    def __init__(self):
        super().__init__()
        self.writes = []
        self.created = None
    def create_user_pool_client(self, **kwargs):
        self.writes.append(kwargs)
        self.native = [{'ClientId': NATIVE, 'ClientName': NAME}]
        self.created = {'UserPoolClient': {'ClientId': NATIVE, 'ClientName': NAME}}
        return copy.deepcopy(self.created)
    def describe_user_pool_client(self, **kwargs):
        return super().describe_user_pool_client(**kwargs) if kwargs['ClientId'] == WEB else copy.deepcopy(self.created)

class RegistrationTests(unittest.TestCase):
    def run_registration(self, cognito, verify=lambda *args: None):
        report = {'create_attempted': False, 'changes_performed': False}
        registration.register(FakeSTS(), cognito, report, policy=lambda pool: POLICY.copy(), verify=verify)
        return report

    def test_one_exact_creation_and_idempotent_reuse(self):
        cognito = WritableCognito()
        self.assertEqual(self.run_registration(cognito)['result'], 'native_client_registered')
        self.assertEqual(cognito.writes, [POLICY])
        self.assertEqual(self.run_registration(cognito)['result'], 'existing_client_verified')
        self.assertEqual(len(cognito.writes), 1)

    def test_invalid_existing_boundaries_never_write(self):
        for kind in ('tier', 'duplicate', 'policy'):
            cognito = WritableCognito()
            if kind == 'tier': cognito.pool['UserPoolTier'] = 'PLUS'
            if kind == 'duplicate': cognito.native = [{'ClientId': NATIVE, 'ClientName': NAME}] * 2
            verify = mock.Mock(side_effect=ValueError('private')) if kind == 'policy' else lambda *args: None
            with self.assertRaises(ValueError): self.run_registration(cognito, verify)
            self.assertEqual(cognito.writes, [])

    def test_client_appearing_before_write_is_reused(self):
        cognito = WritableCognito()
        with mock.patch.object(registration.readiness, 'inspect', side_effect=[{'native_client_present': False}, {'native_client_present': True}]):
            self.assertEqual(self.run_registration(cognito)['result'], 'existing_client_verified')
        self.assertEqual(cognito.writes, [])

    def test_uncertain_write_never_retries_or_claims_no_change(self):
        cognito = WritableCognito()
        cognito.create_user_pool_client = mock.Mock(side_effect=TimeoutError('private'))
        report = {}
        with self.assertRaises(TimeoutError):
            registration.register(FakeSTS(), cognito, report, policy=lambda pool: POLICY.copy(), verify=lambda *args: None)
        cognito.create_user_pool_client.assert_called_once()
        self.assertEqual(report['changes_performed'], 'unknown')

    def test_bad_created_description_does_not_delete_or_update_any_client(self):
        cognito = WritableCognito()
        verify = mock.Mock(side_effect=[None, ValueError('private')])
        with self.assertRaises(ValueError): self.run_registration(cognito, verify)
        self.assertEqual(len(cognito.writes), 1)

    def test_real_pinned_policy_round_trip(self):
        cognito = WritableCognito()
        def create(**kwargs):
            cognito.writes.append(kwargs)
            cognito.native = [{'ClientId': NATIVE, 'ClientName': NAME}]
            value = {k: v for k, v in kwargs.items() if k != 'GenerateSecret'}
            value['ClientId'] = NATIVE
            cognito.created = {'UserPoolClient': value}
            return copy.deepcopy(cognito.created)
        cognito.create_user_pool_client = create
        report = {}
        registration.register(FakeSTS(), cognito, report)
        self.assertEqual(report['result'], 'native_client_registered')
        self.assertEqual(cognito.writes[0]['AllowedOAuthFlows'], ['code'])
        self.assertEqual(cognito.writes[0]['GenerateSecret'], False)
        self.assertEqual(len(cognito.writes), 1)

    def test_main_preserves_uncertain_status_without_service_details(self):
        env = {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main',
               'GITHUB_REPOSITORY': 'HamedGithubforwork/QuizForge-AI', 'GITHUB_RUN_ATTEMPT': '1',
               'REGISTRATION_CONFIRMATION': registration.CONFIRMATION}
        def uncertain(sts, cognito, report):
            report.update(create_attempted=True, changes_performed='unknown')
            raise RuntimeError('private service details')
        with tempfile.TemporaryDirectory() as folder, mock.patch.dict('os.environ', env, clear=True), \
             mock.patch.object(registration, 'RESULT', Path(folder) / 'summary.json'), \
             mock.patch.object(registration.readiness, 'source_commit', return_value='a' * 40), \
             mock.patch.object(registration.subprocess, 'run', return_value=mock.Mock(stdout='a' * 40)), \
             mock.patch.object(registration.boto3, 'client') as client, \
             mock.patch.object(registration, 'register', side_effect=uncertain), mock.patch('builtins.print') as printed:
            self.assertEqual(registration.main(), 1)
            report = json.loads(registration.RESULT.read_text())
            self.assertTrue(report['inspection_required_before_retry'])
            self.assertEqual(report['changes_performed'], 'unknown')
            self.assertNotIn('private service details', str(printed.call_args))
            self.assertEqual(client.call_args.kwargs['config'].retries['total_max_attempts'], 1)

    def test_dispatch_guard_prevents_cloud_calls(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.dict('os.environ', {}, clear=True), \
             mock.patch.object(registration, 'RESULT', Path(folder) / 'summary.json'), \
             mock.patch.object(registration.boto3, 'client') as client, mock.patch('builtins.print'):
            self.assertEqual(registration.main(), 1)
            client.assert_not_called()
            self.assertFalse(json.loads(registration.RESULT.read_text())['changes_performed'])

if __name__ == '__main__': unittest.main()
