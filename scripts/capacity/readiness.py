"""Read-only Lightsail availability check. No instance creation or plan upgrade."""
import json

import boto3
from botocore.exceptions import ClientError


def inspect():
    result = {'region': 'ca-central-1', 'mutations': 0}
    try:
        plan = boto3.client('freetier', region_name='us-east-1').get_account_plan_state()
        result['account_plan'] = {key: plan.get(key) for key in ('accountPlanType', 'accountPlanStatus')}
    except ClientError as error:
        result['account_plan'] = {'unknown': error.response['Error']['Code']}
    client = boto3.client('lightsail', region_name='ca-central-1')
    try:
        bundles = []
        kwargs = {'includeInactive': False}
        while True:
            page = client.get_bundles(**kwargs)
            bundles.extend(b for b in page['bundles'] if b.get('ramSizeInGb') == 2
                           and 'LINUX_UNIX' in b.get('supportedPlatforms', []) and b.get('isActive'))
            if not page.get('nextPageToken'):
                break
            kwargs['pageToken'] = page['nextPageToken']
        result['two_gib_bundles'] = [{k: b.get(k) for k in ('bundleId', 'price', 'cpuCount', 'ramSizeInGb',
                                                           'diskSizeInGb', 'transferPerMonthInGb', 'publicIpv4AddressCount')}
                                     for b in bundles]
    except ClientError as error:
        result['two_gib_bundles'] = {'unknown': error.response['Error']['Code']}
    result['live_capacity_test_performed'] = False
    result['note'] = 'Catalogue access does not prove permission to create resources or Free-plan service eligibility.'
    return result


if __name__ == '__main__':
    print(json.dumps(inspect(), indent=2, sort_keys=True))
