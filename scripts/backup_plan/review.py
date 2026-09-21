"""Read-only checks for the exact retained backup proposal; prints no private plan."""
from collections import Counter
import json
import os
from pathlib import Path
import sys
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

EXPECTED={
 'aws_s3_bucket.backups','aws_s3_bucket_public_access_block.backups',
 'aws_s3_bucket_ownership_controls.backups','aws_s3_bucket_versioning.backups',
 'aws_s3_bucket_server_side_encryption_configuration.backups','aws_s3_bucket_lifecycle_configuration.backups',
 'aws_s3_bucket_policy.backups','aws_iam_policy.uploader','aws_iam_policy.recovery','aws_iam_policy.health',
 'aws_sns_topic.alerts','aws_sns_topic_subscription.owner','aws_cloudwatch_metric_alarm.backup'}
CONFIGURATION='62e39f33d715cc83928390cfd5ff1728008c4053'

def inventory():
    config=Config(ignore_configured_endpoint_urls=True,connect_timeout=10,read_timeout=20,retries={'total_max_attempts':1})
    account=boto3.client('sts',config=config).get_caller_identity()['Account']
    def absent(call,codes):
        try:call()
        except ClientError as error:
            if error.response['Error']['Code'] in codes:return
            raise
        raise ValueError('Named retained resource already exists; inspect/import before activation')
    s3=boto3.client('s3',region_name='ca-central-1',config=config)
    absent(lambda:s3.get_bucket_versioning(Bucket='quizforge-production-backups-'+account,ExpectedBucketOwner=account),{'NoSuchBucket'})
    sns=boto3.client('sns',region_name='ca-central-1',config=config)
    absent(lambda:sns.get_topic_attributes(TopicArn=f'arn:aws:sns:ca-central-1:{account}:quizforge-production-backup-alerts'),{'NotFound','NotFoundException'})
    iam=boto3.client('iam',config=config)
    for name in ('upload','recovery','health'):
        absent(lambda:iam.get_policy(PolicyArn=f'arn:aws:iam::{account}:policy/quizforge-production-backup-'+name),{'NoSuchEntity'})
    cloudwatch=boto3.client('cloudwatch',region_name='ca-central-1',config=config)
    response=cloudwatch.describe_alarms(AlarmNames=['quizforge-production-backup-unhealthy'])
    if response.get('MetricAlarms') or response.get('CompositeAlarms') or response.get('NextToken'):
        raise ValueError('Named backup alarm exists; inspect/import before activation')
    print('PASS: exact retained backup resource names are absent; no resources created')


def review(plan,email):
    if not email or plan.get('errored') or not plan.get('applyable'):
        raise ValueError('Complete plan and selected private recipient required')
    changes=[r for r in plan.get('resource_changes',[]) if r.get('mode')=='managed']
    if {r['address'] for r in changes}!=EXPECTED or len(changes)!=len(EXPECTED):
        raise ValueError('Plan differs from the 13-resource backup proposal')
    if any(r['change']['actions']!=['create'] for r in changes):
        raise ValueError('Initial backup proposal must contain creates only')
    after={r['address']:r['change']['after'] for r in changes}
    block=after['aws_s3_bucket_public_access_block.backups']
    if not all(block[k] for k in ('block_public_acls','block_public_policy','ignore_public_acls','restrict_public_buckets')):
        raise ValueError('Backup storage must remain private')
    if after['aws_s3_bucket.backups']['force_destroy']:
        raise ValueError('Destructive bucket cleanup prohibited')
    if after['aws_s3_bucket_versioning.backups']['versioning_configuration'][0]['status']!='Enabled':
        raise ValueError('Retained object versions required')
    owner=after['aws_sns_topic_subscription.owner']
    if owner['endpoint']!=email or owner['protocol']!='email':raise ValueError('Private recipient mismatch')
    alarm=after['aws_cloudwatch_metric_alarm.backup']
    if alarm['treat_missing_data']!='breaching':raise ValueError('Missing backup heartbeat must alert')
    counts=dict(sorted(Counter(r['type'] for r in changes).items()))
    return {'configuration_sha':CONFIGURATION,'resource_creates':len(changes),'resource_types':counts,
        'private_email_matched':True,'retained_storage':True,'versioning':True,'applied':False,
        'host_created':False,'dns_changed':False,'credentials_created':False,'policy_attachments':0,
        'email_delivery_verified':False,'actual_aws_restore_tested':False}


def main():
    if os.environ.get('GITHUB_REF')!='refs/heads/main' or os.environ.get('GITHUB_EVENT_NAME')!='workflow_dispatch':
        raise ValueError('Trusted manual main invocation required')
    if sys.argv[1]=='inventory':inventory()
    else:
        report=review(json.loads(Path(sys.argv[1]).read_text()),os.environ.get('AWS_BUDGET_ALERT_EMAIL',''))
        Path('backup-plan-results').mkdir(exist_ok=True)
        Path('backup-plan-results/summary.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report,indent=2))

if __name__=='__main__':
    try:main()
    except ClientError as error:
        print('Read-only backup plan refused: '+error.response['Error']['Code'],file=sys.stderr);sys.exit(1)
    except Exception as error:
        print('Read-only backup plan stopped: '+(str(error) if isinstance(error,ValueError) else type(error).__name__),file=sys.stderr);sys.exit(1)
