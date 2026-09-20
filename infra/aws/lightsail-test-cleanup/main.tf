# Preparatory module only: no server, schedule, domain or production resource.
# Use isolated state and inspect the plan before applying this module.
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

resource "aws_scheduler_schedule_group" "capacity" {
  name = "quizforge-capacity-test"
  tags = { Purpose = "quizforge-capacity-test" }
}

resource "aws_iam_role" "cleanup" {
  name = "quizforge-capacity-test-cleanup"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "scheduler.amazonaws.com" },
    Action = "sts:AssumeRole", Condition = { StringEquals = {
      "aws:SourceAccount" = data.aws_caller_identity.current.account_id,
      "aws:SourceArn"     = aws_scheduler_schedule_group.capacity.arn
    } }
  }] })
  tags = { Purpose = "quizforge-capacity-test" }
}

resource "aws_iam_role_policy" "cleanup" {
  name = "delete-capacity-test"
  role = aws_iam_role.cleanup.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow", Action = ["lightsail:DeleteInstance"],
    Resource  = "arn:aws:lightsail:ca-central-1:${data.aws_caller_identity.current.account_id}:Instance/*",
    Condition = { StringEquals = { "aws:ResourceTag/Purpose" = "quizforge-capacity-test" } }
  }] })
}

output "cleanup_role" {
  value = aws_iam_role.cleanup.arn
}
