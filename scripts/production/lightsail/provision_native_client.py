"""Register the reviewed public desktop client without modifying existing clients."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

import boto3
from botocore.config import Config

from scripts.production.lightsail import native_auth_readiness as readiness

RESULT = Path('native-client-registration-results/summary.json')
CONFIRMATION = 'register-reviewed-desktop-client'


def register(sts, cognito, report, *, policy=readiness.expected_policy, verify=readiness.verify_policy):
    before = readiness.inspect(sts, cognito, policy=policy, verify=verify)
    report['existing_boundaries_verified'] = True
    if before['native_client_present']:
        report['configuration_verified'] = True
        report['result'] = 'existing_client_verified'
        return
    pool_id, web_id = readiness.discover(cognito)
    expected = policy(pool_id)
    # Validate the exact proposed request before giving it to AWS.
    proposed = {k: v for k, v in expected.items() if k != 'GenerateSecret'}
    proposed['ClientId'] = 'syntheticnativevalidation'
    verify({'UserPoolClient': proposed}, pool_id, web_id)
    if expected.get('GenerateSecret') is not False or expected.get('UserPoolId') != pool_id:
        raise ValueError('Invalid public client request')
    # Repeat the complete read-only check immediately before the sole write.
    if readiness.inspect(sts, cognito, policy=policy, verify=verify)['native_client_present']:
        report['configuration_verified'] = True
        report['result'] = 'existing_client_verified'
        return
    report['create_attempted'] = True
    report['changes_performed'] = 'unknown'
    created = cognito.create_user_pool_client(**expected)
    report['changes_performed'] = True
    verify(created, pool_id, web_id)
    client_id = created['UserPoolClient']['ClientId']
    described = cognito.describe_user_pool_client(UserPoolId=pool_id, ClientId=client_id)
    if described.get('UserPoolClient', {}).get('ClientId') != client_id:
        raise ValueError('Unexpected created client identity')
    verify(described, pool_id, web_id)
    after = readiness.inspect(sts, cognito, policy=policy, verify=verify)
    if not after['native_client_present']:
        raise ValueError('Created client not visible in final inventory')
    report['configuration_verified'] = True
    report['result'] = 'native_client_registered'


def main():
    report = {'schema': 1, 'result': 'registration_failed', 'existing_boundaries_verified': False,
              'create_attempted': False, 'changes_performed': False, 'configuration_verified': False,
              'existing_clients_modified': False, 'application_deployed': False, 'login_acceptance_performed': False}
    try:
        if (os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
                or os.environ.get('GITHUB_REF') != 'refs/heads/main'
                or os.environ.get('GITHUB_REPOSITORY') != 'HamedGithubforwork/QuizForge-AI'
                or os.environ.get('GITHUB_RUN_ATTEMPT') != '1'
                or os.environ.get('REGISTRATION_CONFIRMATION') != CONFIRMATION):
            raise ValueError('Explicit first-attempt main dispatch required')
        commit = readiness.source_commit()
        actual = subprocess.run(['git', '-C', str(readiness.CHECKOUT), 'rev-parse', 'HEAD'],
                                capture_output=True, text=True, timeout=10, check=True).stdout.strip()
        if actual != commit:
            raise ValueError('Wrong policy checkout')
        # CreateUserPoolClient has no idempotency token; never auto-retry an uncertain write.
        config = Config(retries={'total_max_attempts': 1}, connect_timeout=10, read_timeout=30)
        register(boto3.client('sts', region_name=readiness.REGION, config=config),
                 boto3.client('cognito-idp', region_name=readiness.REGION, config=config), report)
        report['configuration_commit'] = commit
    except Exception:
        # No raw AWS responses or exception text. An uncertain write requires inventory inspection.
        report['inspection_required_before_retry'] = report['create_attempted']
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return 0 if report['result'] in ('existing_client_verified', 'native_client_registered') else 1


if __name__ == '__main__':
    raise SystemExit(main())
