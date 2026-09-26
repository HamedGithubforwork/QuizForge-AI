"""One fixed Canadian laboratory; no production, DNS, model or IAM write access."""
import json
import re

REGION = 'ca-central-1'
GROUP = 'quizforge-capacity-test'
ROLE = 'quizforge-capacity-test-cleanup'
PURPOSE = 'quizforge-capacity-test'
PREFIX = 'qf-capacity-'
APP_SHA = 'bff2ab7612951fe1612268af3772794651ea86c8'
HARNESS_SHA = '52f44f16794369601f21e429b15389efcf7d62e4'
BUNDLE = 'small_3_0'
BLUEPRINT = 'ubuntu_24_04'
MAX_MONTHLY_USD = 12
TTL_SECONDS = 7200


def account_id(value):
    if not re.fullmatch(r'[0-9]{12}', value):
        raise ValueError('Invalid AWS account ID')
    return value


def test_name(value):
    if not re.fullmatch(r'[1-9][0-9]{0,19}-[1-9][0-9]{0,4}', value):
        raise ValueError('Test ID must be GitHub run ID-attempt')
    return PREFIX + value


def cleanup_policy(account):
    account_id(account)
    return {'Version': '2012-10-17', 'Statement': [{
        'Effect': 'Allow', 'Action': ['lightsail:DeleteInstance'],
        'Resource': f'arn:aws:lightsail:{REGION}:{account}:Instance/*',
        'Condition': {'StringEquals': {'aws:ResourceTag/Purpose': PURPOSE}}}]}


def cleanup_trust(account):
    account_id(account)
    return {'Version': '2012-10-17', 'Statement': [{
        'Effect': 'Allow', 'Principal': {'Service': 'scheduler.amazonaws.com'},
        'Action': 'sts:AssumeRole', 'Condition': {'StringEquals': {
            'aws:SourceAccount': account,
            'aws:SourceArn': f'arn:aws:scheduler:{REGION}:{account}:schedule-group/{GROUP}'}}}]}


def session_policy(account, operation, ident=None):
    account_id(account)
    if operation not in ('inspect', 'run', 'cleanup'):
        raise ValueError('Unsupported operation')
    if operation == 'run':
        test_name(ident or '')
    role = f'arn:aws:iam::{account}:role/{ROLE}'
    schedule = f'arn:aws:scheduler:{REGION}:{account}:schedule/{GROUP}/{PREFIX}*'
    statements = [
        {'Effect': 'Allow', 'Action': ['sts:GetCallerIdentity', 'freetier:GetAccountPlanState',
         'lightsail:GetBundles', 'lightsail:GetBlueprints', 'lightsail:GetRegions',
         'lightsail:GetInstances', 'lightsail:GetInstance',
         'lightsail:GetInstanceMetricData', 'lightsail:GetInstancePortStates'], 'Resource': '*'},
        {'Effect': 'Allow', 'Action': ['iam:GetRole', 'iam:GetRolePolicy',
         'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies'], 'Resource': role},
        {'Effect': 'Allow', 'Action': ['scheduler:GetScheduleGroup'],
         'Resource': f'arn:aws:scheduler:{REGION}:{account}:schedule-group/{GROUP}'},
        {'Effect': 'Allow', 'Action': ['scheduler:GetSchedule'] +
         (['scheduler:CreateSchedule'] if operation == 'run' else []), 'Resource': schedule}]
    if operation in ('run', 'cleanup'):
        statements.append({'Effect': 'Allow', 'Action': ['lightsail:DeleteInstance'] +
            (['lightsail:GetInstanceAccessDetails', 'lightsail:PutInstancePublicPorts'] if operation == 'run' else []),
            'Resource': f'arn:aws:lightsail:{REGION}:{account}:Instance/*',
            'Condition': {'StringEquals': {'aws:ResourceTag/Purpose': PURPOSE}}})
    if operation == 'run':
        statements.extend([
            {'Effect': 'Allow', 'Action': ['lightsail:CreateInstances'], 'Resource': '*',
             'Condition': {'StringEquals': {'aws:RequestedRegion': REGION,
                                           'aws:RequestTag/Purpose': PURPOSE}}},
            {'Effect': 'Allow', 'Action': ['lightsail:TagResource'],
             'Resource': f'arn:aws:lightsail:{REGION}:{account}:Instance/*',
             'Condition': {'StringEquals': {'aws:RequestTag/Purpose': PURPOSE,
                                             'aws:RequestTag/TestId': ident},
                           'ForAllValues:StringEquals': {'aws:TagKeys': ['Purpose', 'TestId', 'DeleteAfter']}}},
            {'Effect': 'Allow', 'Action': ['iam:PassRole'], 'Resource': role,
             'Condition': {'StringEquals': {'iam:PassedToService': 'scheduler.amazonaws.com'}}}])
    return {'Version': '2012-10-17', 'Statement': statements}


if __name__ == '__main__':
    import os
    operation = os.environ['OPERATION']
    ident = os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT'] if operation == 'run' else None
    policy = session_policy(os.environ['TEST_ACCOUNT_ID'], operation, ident)
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write('json=' + json.dumps(policy, separators=(',', ':')) + '\n')
