provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

data "aws_caller_identity" "current" {}

data "aws_iam_role" "ecs_task_execution" {
  name = "${var.project_name}-ecs-task-execution"
}

data "terraform_remote_state" "foundation" {
  backend = "s3"

  config = {
    bucket = var.foundation_state_bucket
    key    = "quizforge/foundation/terraform.tfstate"
    region = var.aws_region
  }
}

locals {
  foundation             = data.terraform_remote_state.foundation.outputs
  parameter_store_prefix = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/quizforge/prod"
}
