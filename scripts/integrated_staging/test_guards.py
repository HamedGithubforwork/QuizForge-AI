from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock
from botocore.exceptions import ClientError
from guards import NAME, public_config, permitted_state, owned_task
from control import hosting, state_resources, wait_for_backups_absent


class Boundaries(unittest.TestCase):
    def config(self):
        return dict(pool="ca-central-1_Test",client="client123",auth_origin="https://quizforge-integrated-123456789012.auth.ca-central-1.amazoncognito.com",
                    frontend_url="https://d123.cloudfront.net",api_url="https://staging-api.quizfromnotes.com",
                    deadline=(datetime.now(timezone.utc)+timedelta(hours=1)).isoformat())

    def test_exact_public_config(self):
        self.assertEqual(public_config(self.config())["client"], "client123")

    def test_secret_or_unrelated_origin_refused(self):
        for change in ({"password":"hidden"},{"api_url":"https://production.example"},
                       {"auth_origin":"https://evil.example"},{"frontend_url":"https://d123.cloudfront.net.evil.example"},
                       {"pool":"us-east-1_Test"}):
            with self.subTest(change=list(change)), self.assertRaises(AssertionError):
                public_config(self.config()|change)

    def test_expired_or_extended_lease_refused(self):
        for delta in (-1, 4):
            data=self.config(); data["deadline"]=(datetime.now(timezone.utc)+timedelta(hours=delta)).isoformat()
            with self.assertRaises(AssertionError): public_config(data)

    def test_cleanup_never_accepts_other_state_addresses(self):
        permitted_state(['aws_ecs_service.app["api"]','aws_db_instance.db','aws_s3_bucket.site'])
        for item in ('aws_db_instance.production','module.production.aws_s3_bucket.site','aws_route53_zone.production','aws_acm_certificate.api'):
            with self.assertRaises(AssertionError): permitted_state([item])

    def test_cleanup_uses_exact_task_family(self):
        def task(family): return {"taskDefinitionArn":"arn:aws:ecs:ca-central-1:123456789012:task-definition/"+family+":1"}
        self.assertTrue(owned_task(task(NAME+'-api')))
        for family in ('quizforge-api-staging',NAME+'-api-production','quizforge-rds-rehearsal'):
            self.assertFalse(owned_task(task(family)))

    @patch.dict('os.environ', {'TF_VAR_foundation_state_bucket':'test-state'})
    def test_only_missing_state_object_is_empty(self):
        with patch('control.client') as aws, patch('control.tf') as terraform:
            for code in ('404', 'NoSuchKey'):
                aws.return_value.head_object.side_effect = ClientError({'Error':{'Code':code}}, 'HeadObject')
                self.assertEqual(state_resources(), [])
            terraform.assert_not_called()
            for code in ('403', 'AccessDenied', 'NoSuchBucket', 'ServiceUnavailable'):
                aws.return_value.head_object.side_effect = ClientError({'Error':{'Code':code}}, 'HeadObject')
                with self.assertRaises(ClientError): state_resources()
            aws.return_value.head_object.side_effect = None
            terraform.return_value = 'aws_db_instance.db\n'
            self.assertEqual(state_resources(), ['aws_db_instance.db'])
            aws.return_value.head_object.assert_called_with(Bucket='test-state', Key='quizforge/integrated-staging/terraform.tfstate')

    def test_artifact_rejects_credential_file_and_symlink(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root); (p/'index.html').write_text('app'); (p/'assets').mkdir(); (p/'assets/main.js').write_text('app')
            self.assertEqual(len(hosting.inventory(p)),2)
            (p/'.env').write_text('secret')
            with self.assertRaises(ValueError): hosting.inventory(p)
            (p/'.env').unlink(); (p/'assets/link.js').symlink_to(p/'index.html')
            with self.assertRaises(ValueError): hosting.inventory(p)

    @patch('control.time.sleep')
    def test_backup_absence_waits_for_both_inventories(self, sleep):
        rds = Mock()
        snapshots, backups = Mock(), Mock()
        rds.get_paginator.side_effect = lambda name: snapshots if name == 'describe_db_snapshots' else backups
        foreign = {'DBInstanceIdentifier':'production'}
        snapshots.paginate.side_effect = [
            [{'DBSnapshots':[foreign, {'DBInstanceIdentifier':NAME,'SnapshotType':'automated','Status':'deleting'}]}],
            [{'DBSnapshots':[foreign]}], [{'DBSnapshots':[foreign]}]]
        backups.paginate.side_effect = [[{'DBInstanceAutomatedBackups':[]}],
            [{'DBInstanceAutomatedBackups':[{'DBInstanceIdentifier':NAME,'Status':'retained'}]}],
            [{'DBInstanceAutomatedBackups':[foreign]}]]
        wait_for_backups_absent(rds, attempts=3, delay=0)
        self.assertEqual(sleep.call_count, 2)

    @patch('control.time.sleep')
    def test_retained_backup_never_counts_as_absent(self, sleep):
        rds = Mock()
        snapshots, backups = Mock(), Mock()
        rds.get_paginator.side_effect = lambda name: snapshots if name == 'describe_db_snapshots' else backups
        snapshots.paginate.return_value = [{'DBSnapshots':[{'DBInstanceIdentifier':NAME,'SnapshotType':'manual','Status':'available'}]}]
        backups.paginate.return_value = [{'DBInstanceAutomatedBackups':[]}]
        with self.assertRaises(AssertionError): wait_for_backups_absent(rds, attempts=2, delay=0)
        snapshots.paginate.side_effect = ClientError({'Error':{'Code':'AccessDenied'}}, 'DescribeDBSnapshots')
        with self.assertRaises(ClientError): wait_for_backups_absent(rds, attempts=2, delay=0)


if __name__ == '__main__': unittest.main()
