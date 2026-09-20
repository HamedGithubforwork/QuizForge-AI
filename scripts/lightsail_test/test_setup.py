import copy
import json
import unittest

from policy import GROUP, ROLE, PURPOSE, cleanup_policy, cleanup_trust
from setup import setup_session, validate_plan

ACCOUNT = '123456789012'


def fixture():
    values = {
        'aws_scheduler_schedule_group.capacity': {'name': GROUP, 'tags': {'Purpose': PURPOSE}},
        'aws_iam_role.cleanup': {'name': ROLE, 'path': '/', 'tags': {'Purpose': PURPOSE},
                               'assume_role_policy': json.dumps(cleanup_trust(ACCOUNT))},
        'aws_iam_role_policy.cleanup': {'name': 'delete-capacity-test', 'role': ROLE,
                                      'policy': json.dumps(cleanup_policy(ACCOUNT))}}
    return {'resource_changes': [{'address': a, 'type': a.split('.')[0], 'mode': 'managed',
                                 'change': {'actions': ['create'], 'after': v}} for a, v in values.items()]}


class SetupBoundaries(unittest.TestCase):
    def test_plan_has_only_three_creates_and_no_billable_server(self):
        self.assertEqual(validate_plan(fixture(), ACCOUNT)['creates'], 3)
        for action in ('update', 'delete'):
            plan = fixture()
            plan['resource_changes'][0]['change']['actions'] = [action]
            with self.assertRaises(ValueError):
                validate_plan(plan, ACCOUNT)
        plan = fixture()
        plan['resource_changes'].append({'address': 'aws_lightsail_instance.unexpected', 'mode': 'managed'})
        with self.assertRaises(ValueError):
            validate_plan(plan, ACCOUNT)

    def test_broader_permissions_or_trust_are_rejected(self):
        for index, field, document in [(2, 'policy', cleanup_policy(ACCOUNT)), (1, 'assume_role_policy', cleanup_trust(ACCOUNT))]:
            plan = fixture()
            changed = copy.deepcopy(document)
            changed['Statement'][0].pop('Condition')
            plan['resource_changes'][index]['change']['after'][field] = json.dumps(changed)
            with self.assertRaises(ValueError):
                validate_plan(plan, ACCOUNT)

    def test_plan_session_is_read_only_and_apply_cannot_create_servers(self):
        for operation in ('plan', 'apply'):
            document = setup_session(ACCOUNT, 'test-state-bucket', operation)
            self.assertLessEqual(len(json.dumps(document, separators=(',', ':'))), 2048)
            actions = [a for s in document['Statement'] for a in s['Action']]
            self.assertFalse(any(a.startswith('lightsail:') for a in actions))
            self.assertNotIn('iam:AttachRolePolicy', actions)
            self.assertNotIn('iam:PassRole', actions)
            if operation == 'plan':
                self.assertTrue(all(a.split(':')[1].startswith(('Get', 'List')) for a in actions))


if __name__ == '__main__':
    unittest.main()
