import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts.production.lightsail import native_auth_readiness as readiness
from scripts.production.lightsail.style_cognito_hosted_ui import CLIENT_NAME, POOL_NAME

POOL = 'ca-central-1_Synthetic'
WEB = 'syntheticweb'
NATIVE = 'syntheticnative'
NAME = 'quiz-from-notes-desktop-preview'


class FakeSTS:
    def get_caller_identity(self):
        return {'Account': '123456789012'}


class FakeCognito:
    def __init__(self):
        self.native = []
        self.pool = {'Id': POOL, 'Name': POOL_NAME, 'UserPoolTier': 'LITE', 'DeletionProtection': 'ACTIVE'}
        self.domain = {'UserPoolId': POOL, 'AWSAccountId': '123456789012', 'Status': 'ACTIVE', 'ManagedLoginVersion': 1}
        self.web = {'UserPoolId': POOL, 'ClientId': WEB, 'ClientName': CLIENT_NAME,
                    'AllowedOAuthFlows': ['code'], 'CallbackURLs': ['https://quizfromnotes.com/auth/callback']}

    def list_user_pools(self, **kwargs):
        return {'UserPools': [{'Id': POOL, 'Name': POOL_NAME}]}

    def list_user_pool_clients(self, **kwargs):
        return {'UserPoolClients': [{'ClientId': WEB, 'ClientName': CLIENT_NAME}, *self.native]}

    def describe_user_pool(self, **kwargs):
        return {'UserPool': self.pool}

    def describe_user_pool_domain(self, **kwargs):
        assert kwargs['Domain'] == 'quizforge-123456789012'
        return {'DomainDescription': self.domain}

    def describe_user_pool_client(self, **kwargs):
        return {'UserPoolClient': self.web if kwargs['ClientId'] == WEB else {'ClientId': NATIVE}}


class ReadinessTests(unittest.TestCase):
    def inspect(self, cognito, verify=lambda *args: None):
        return readiness.inspect(FakeSTS(), cognito, policy=lambda pool: {'ClientName': NAME}, verify=verify)

    def test_absent_client_is_a_successful_read_only_finding_without_identifiers(self):
        summary = self.inspect(FakeCognito())
        self.assertEqual(summary['result'], 'registration_required')
        self.assertFalse(summary['changes_performed'])
        raw = json.dumps(summary)
        for value in (POOL, WEB, NATIVE, '123456789012'):
            self.assertNotIn(value, raw)

    def test_existing_client_must_pass_pinned_policy(self):
        cognito = FakeCognito()
        cognito.native = [{'ClientName': NAME, 'ClientId': NATIVE}]
        verify = mock.Mock()
        self.assertEqual(self.inspect(cognito, verify)['result'], 'client_configuration_verified')
        verify.assert_called_once_with({'UserPoolClient': {'ClientId': NATIVE}}, POOL, WEB)
        verify.side_effect = ValueError('private settings')
        with self.assertRaises(ValueError):
            self.inspect(cognito, verify)

    def test_ambiguous_client_and_web_reuse_are_rejected(self):
        for native in ([{'ClientName': NAME, 'ClientId': WEB}], [{'ClientName': NAME, 'ClientId': NATIVE}] * 2):
            cognito = FakeCognito(); cognito.native = native
            with self.assertRaises(ValueError):
                self.inspect(cognito)

    def test_foreign_pool_domain_tier_and_web_boundaries_are_rejected(self):
        for target, key, value in [('pool', 'Id', 'other'), ('pool', 'UserPoolTier', 'PLUS'),
                                   ('pool', 'DeletionProtection', 'INACTIVE'), ('domain', 'UserPoolId', 'other'),
                                   ('domain', 'AWSAccountId', '000000000000'), ('domain', 'ManagedLoginVersion', 2),
                                   ('domain', 'Status', 'CREATING'), ('web', 'ClientSecret', 'private'),
                                   ('web', 'AllowedOAuthFlows', ['implicit']), ('web', 'CallbackURLs', ['https://other.invalid'])]:
            with self.subTest(target=target, key=key):
                cognito = FakeCognito(); getattr(cognito, target)[key] = value
                with self.assertRaises(ValueError):
                    self.inspect(cognito)

    def test_wrong_checkout_fails_before_cloud_calls_and_does_not_log_error(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'summary.json'
            with mock.patch.object(readiness, 'RESULT', output), mock.patch.object(readiness, 'source_commit', return_value='a' * 40), \
                 mock.patch.object(readiness.subprocess, 'run', return_value=mock.Mock(stdout='b' * 40)), \
                 mock.patch.object(readiness.boto3, 'client') as client, mock.patch('builtins.print') as printed:
                self.assertEqual(readiness.main(), 1)
                client.assert_not_called()
                self.assertEqual(json.loads(output.read_text())['result'], 'inspection_failed')
                self.assertNotIn('bbbb', str(printed.call_args))

    def test_policy_helper_failures_are_generic(self):
        with mock.patch.object(readiness.subprocess, 'run', return_value=mock.Mock(returncode=1, stdout='private')):
            with self.assertRaisesRegex(ValueError, '^Native client policy check failed$'):
                readiness.policy_command('verify')


if __name__ == '__main__':
    unittest.main()
