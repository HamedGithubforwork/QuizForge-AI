"""Plan/apply guard for the three cleanup prerequisites; never launches a server."""
import json
import os
from pathlib import Path
import re
import sys

from policy import REGION, GROUP, ROLE, PURPOSE, account_id, cleanup_policy, cleanup_trust

STATE_KEY = 'quizforge/lightsail-test-cleanup/terraform.tfstate'


def setup_session(account, bucket, operation):
    account_id(account)
    if operation not in ('plan', 'apply') or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', bucket):
        raise ValueError('Invalid setup operation or state bucket')
    role = f'arn:aws:iam::{account}:role/{ROLE}'
    group = f'arn:aws:scheduler:{REGION}:{account}:schedule-group/{GROUP}'
    state = f'arn:aws:s3:::{bucket}/{STATE_KEY}'
    role_actions = ['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies',
                    'iam:ListAttachedRolePolicies', 'iam:ListInstanceProfilesForRole']
    group_actions = ['scheduler:GetScheduleGroup', 'scheduler:ListTagsForResource']
    statements = [
        {'Effect': 'Allow', 'Action': ['sts:GetCallerIdentity'], 'Resource': '*'},
        {'Effect': 'Allow', 'Action': ['s3:ListBucket', 's3:GetBucketLocation'], 'Resource': f'arn:aws:s3:::{bucket}'},
        {'Effect': 'Allow', 'Action': ['s3:GetObject'], 'Resource': [state, state + '.tflock']}]
    if operation == 'apply':
        role_actions += ['iam:CreateRole', 'iam:TagRole', 'iam:PutRolePolicy']
        group_actions += ['scheduler:CreateScheduleGroup', 'scheduler:TagResource']
        statements += [
            {'Effect': 'Allow', 'Action': ['s3:PutObject'], 'Resource': [state, state + '.tflock']},
            {'Effect': 'Allow', 'Action': ['s3:DeleteObject'], 'Resource': state + '.tflock'}]
    statements += [
        {'Effect': 'Allow', 'Action': role_actions, 'Resource': role},
        {'Effect': 'Allow', 'Action': group_actions, 'Resource': group}]
    return {'Version': '2012-10-17', 'Statement': statements}


def validate_plan(plan, account):
    expected = {
        'aws_scheduler_schedule_group.capacity': 'aws_scheduler_schedule_group',
        'aws_iam_role.cleanup': 'aws_iam_role',
        'aws_iam_role_policy.cleanup': 'aws_iam_role_policy'}
    resources = {r['address']: r for r in plan.get('resource_changes', []) if r.get('mode') == 'managed'}
    if set(resources) != set(expected) or plan.get('errored'):
        raise ValueError('Setup plan must contain exactly the three cleanup resources')
    counts = {'create': 0, 'no-op': 0}
    for address, kind in expected.items():
        item = resources[address]
        actions = item['change']['actions']
        if item['type'] != kind or actions not in (['create'], ['no-op']):
            raise ValueError('Setup cannot update, replace or destroy resources')
        counts[actions[0]] += 1
    group = resources['aws_scheduler_schedule_group.capacity']['change']['after']
    role = resources['aws_iam_role.cleanup']['change']['after']
    permissions = resources['aws_iam_role_policy.cleanup']['change']['after']
    if group['name'] != GROUP or group.get('tags') != {'Purpose': PURPOSE}:
        raise ValueError('Unexpected schedule group scope')
    if role['name'] != ROLE or role.get('path') != '/' or role.get('tags') != {'Purpose': PURPOSE}:
        raise ValueError('Unexpected IAM role scope')
    if (role.get('permissions_boundary') or role.get('managed_policy_arns') or role.get('inline_policy')
            or json.loads(role['assume_role_policy']) != cleanup_trust(account)):
        raise ValueError('Unexpected IAM role trust or additional permissions')
    if (permissions['name'] != 'delete-capacity-test' or permissions.get('role') != ROLE
            or json.loads(permissions['policy']) != cleanup_policy(account)):
        raise ValueError('Cleanup policy exceeds tagged-instance deletion')
    return {'creates': counts['create'], 'unchanged': counts['no-op'], 'updates': 0, 'deletes': 0,
            'servers': 0, 'resources': sorted(resources)}


if __name__ == '__main__':
    account = os.environ['TEST_ACCOUNT_ID']
    if sys.argv[1] == 'policy':
        document = setup_session(account, os.environ['STATE_BUCKET'], os.environ['OPERATION'])
        encoded = json.dumps(document, separators=(',', ':'))
        if len(encoded) > 2048:
            raise SystemExit('Session policy exceeds STS size limit')
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write('json=' + encoded + '\n')
    elif sys.argv[1] == 'check':
        print(json.dumps(validate_plan(json.loads(Path(sys.argv[2]).read_text()), account), indent=2))
    else:
        raise SystemExit('Unknown setup command')
