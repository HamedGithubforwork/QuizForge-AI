# Preparation only. CI uses mocked plans; there is no apply workflow.
terraform {
  required_version = ">= 1.10.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.64.0"
    }
  }
  backend "s3" {}
}

provider "aws" {
  region = "ca-central-1"
}

data "aws_caller_identity" "current" {}

variable "alert_email" {
  description = "Owner-selected backup alert recipient; application requires SNS confirmation."
  type        = string
  sensitive   = true
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "Provide the reviewed alert recipient before preparing an activation plan."
  }
}

locals {
  bucket_name = "quizforge-production-backups-${data.aws_caller_identity.current.account_id}"
  bucket_arn  = "arn:aws:s3:::${local.bucket_name}"
  tags        = { Project = "QuizForge", Purpose = "production-backup" }
  metric_statement = {
    Effect    = "Allow", Action = ["cloudwatch:PutMetricData"], Resource = "*",
    Condition = { StringEquals = { "cloudwatch:namespace" = "QuizForge/Backup" } }
  }
}

resource "aws_s3_bucket" "backups" {
  bucket        = local.bucket_name
  force_destroy = false
  tags          = local.tags
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket     = aws_s3_bucket.backups.id
  depends_on = [aws_s3_bucket_versioning.backups]
  rule {
    id     = "bounded-recovery-window"
    status = "Enabled"
    filter {}
    expiration {
      days = 7
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
  rule {
    id     = "remove-expired-markers"
    status = "Enabled"
    filter {}
    expiration {
      expired_object_delete_marker = true
    }
  }
}

resource "aws_s3_bucket_policy" "backups" {
  bucket = aws_s3_bucket.backups.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    {
      Sid       = "RequireTLS", Effect = "Deny", Principal = "*", Action = "s3:*",
      Resource  = [local.bucket_arn, "${local.bucket_arn}/*"],
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    },
    {
      Sid       = "RequireEncryption", Effect = "Deny", Principal = "*", Action = "s3:PutObject",
      Resource  = "${local.bucket_arn}/*",
      Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption" = "AES256" } }
    },
    {
      Sid       = "RequireConditionalCreate", Effect = "Deny", Principal = "*", Action = "s3:PutObject",
      Resource  = "${local.bucket_arn}/*",
      Condition = { StringNotEquals = { "s3:if-none-match" = "*" } }
    }
  ] })
}

# Policies are intentionally unattached. Credential delivery and separate
# uploader/recovery identities are reviewed during permanent host preparation.
resource "aws_iam_policy" "uploader" {
  name = "quizforge-production-backup-upload"
  tags = local.tags
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetBucketVersioning"], Resource = local.bucket_arn },
    { Effect = "Allow", Action = ["s3:PutObject"], Resource = ["${local.bucket_arn}/lightsail/*", "${local.bucket_arn}/receipts/*"] },
    local.metric_statement
  ] })
}

resource "aws_iam_policy" "recovery" {
  name = "quizforge-production-backup-recovery"
  tags = local.tags
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:ListBucketVersions"], Resource = local.bucket_arn,
    Condition = { StringLike = { "s3:prefix" = "receipts/*" } } },
    { Effect = "Allow", Action = ["s3:GetObjectVersion"], Resource = ["${local.bucket_arn}/lightsail/*", "${local.bucket_arn}/receipts/*"] }
  ] })
}

resource "aws_iam_policy" "health" {
  name   = "quizforge-production-backup-health"
  tags   = local.tags
  policy = jsonencode({ Version = "2012-10-17", Statement = [local.metric_statement] })
}

resource "aws_sns_topic" "alerts" {
  name = "quizforge-production-backup-alerts"
  tags = local.tags
}

resource "aws_sns_topic_subscription" "owner" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "backup" {
  alarm_name          = "quizforge-production-backup-unhealthy"
  alarm_description   = "Failed backup, no valid snapshot within 26 hours, or missing hourly host heartbeat."
  namespace           = "QuizForge/Backup"
  metric_name         = "BackupFresh"
  dimensions          = { Deployment = "production-lightsail" }
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  period              = 3600
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  statistic           = "Minimum"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = local.tags
}

output "backup_bucket" {
  value = aws_s3_bucket.backups.id
}

output "uploader_policy_arn" {
  value = aws_iam_policy.uploader.arn
}

output "recovery_policy_arn" {
  value = aws_iam_policy.recovery.arn
}

output "health_policy_arn" {
  value = aws_iam_policy.health.arn
}
