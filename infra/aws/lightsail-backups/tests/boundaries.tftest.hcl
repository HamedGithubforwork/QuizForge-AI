mock_provider "aws" {}

run "private_retained_backups_and_independent_alarm" {
  command = plan
  variables {
    alert_email = "synthetic-alerts@example.invalid"
  }
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }
  assert {
    condition     = aws_s3_bucket.backups.bucket == "quizforge-production-backups-123456789012" && !aws_s3_bucket.backups.force_destroy
    error_message = "Only the retained production backup bucket may be configured."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.backups.block_public_acls && aws_s3_bucket_public_access_block.backups.block_public_policy && aws_s3_bucket_public_access_block.backups.ignore_public_acls && aws_s3_bucket_public_access_block.backups.restrict_public_buckets
    error_message = "Every public access mechanism must remain blocked."
  }
  assert {
    condition     = aws_s3_bucket_versioning.backups.versioning_configuration[0].status == "Enabled"
    error_message = "Backups and receipts require retained versions."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.backup.treat_missing_data == "breaching" && aws_cloudwatch_metric_alarm.backup.statistic == "Minimum" && aws_cloudwatch_metric_alarm.backup.period == 3600 && aws_cloudwatch_metric_alarm.backup.threshold == 1
    error_message = "A dead backup host must not suppress the external alarm."
  }
  assert {
    condition     = jsondecode(aws_iam_policy.uploader.policy).Statement[1].Action == ["s3:PutObject"] && length(jsondecode(aws_iam_policy.uploader.policy).Statement) == 3
    error_message = "The routine uploader must not receive read/delete or database restore permissions."
  }
  assert {
    condition     = jsondecode(aws_iam_policy.recovery.policy).Statement[1].Action == ["s3:GetObjectVersion"] && length(jsondecode(aws_iam_policy.recovery.policy).Statement) == 2
    error_message = "Recovery must read exact versions without write/delete permissions."
  }
  assert {
    condition     = jsondecode(aws_iam_policy.health.policy).Statement[0].Condition.StringEquals["cloudwatch:namespace"] == "QuizForge/Backup" && length(jsondecode(aws_iam_policy.health.policy).Statement) == 1
    error_message = "Health credentials must have only namespace-scoped metric publication."
  }
  assert {
    condition     = jsondecode(aws_s3_bucket_policy.backups.policy).Statement[2].Condition.StringNotEquals["s3:if-none-match"] == "*"
    error_message = "Uploads must be conditional creates, including signed receipts."
  }
}
