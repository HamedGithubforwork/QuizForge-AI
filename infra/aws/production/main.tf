# Permanent resources. No disposable controller may open this root or state.
terraform {
  required_version = ">= 1.10.0, < 2.0.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.64.0, < 7.0.0" }
  }
  backend "s3" {}
}
provider "aws" {
  region = "ca-central-1"
  default_tags {
    tags = { Project = "QuizForge-AI", Environment = "production", Temporary = "false" }
  }
}
provider "aws" {
  alias  = "edge"
  region = "us-east-1"
  default_tags {
    tags = { Project = "QuizForge-AI", Environment = "production", Temporary = "false" }
  }
}
variable "foundation_state_bucket" { type = string }
variable "zone_id" { type = string }
variable "monthly_budget_usd" {
  type        = number
  description = "Owner-selected AWS alert threshold, not a spending cap."
  validation {
    condition     = var.monthly_budget_usd >= 1 && var.monthly_budget_usd <= 1000
    error_message = "Set an explicit reviewed monthly AWS alert threshold between USD 1 and 1000."
  }
}
variable "alert_email" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.alert_email))
    error_message = "A confirmed operator email address is required for operational alerts."
  }
}
variable "enable_api" {
  type    = bool
  default = false
}
variable "publish_dns" {
  type    = bool
  default = false
}
variable "public_signup" {
  type    = bool
  default = false
}
variable "api_image" {
  type    = string
  default = ""
  validation {
    condition     = var.api_image == "" || can(regex("^[0-9]{12}\\.dkr\\.ecr\\.ca-central-1\\.amazonaws\\.com/quizforge-api@sha256:[a-f0-9]{64}$", var.api_image))
    error_message = "Use an immutable, reviewed application image digest."
  }
}
variable "operations_image" {
  type    = string
  default = ""
  validation {
    condition     = var.operations_image == "" || can(regex("^[0-9]{12}\\.dkr\\.ecr\\.ca-central-1\\.amazonaws\\.com/quizforge-api@sha256:[a-f0-9]{64}$", var.operations_image))
    error_message = "Use an immutable, reviewed operations image digest."
  }
}
variable "legacy_publishable_key" {
  type        = string
  default     = ""
  description = "Only the source publishable/anon key, never a privileged service-role key."
}
data "aws_caller_identity" "current" {}
data "terraform_remote_state" "foundation" {
  backend = "s3"
  config = {
    bucket = var.foundation_state_bucket
    key    = "quizforge/foundation/terraform.tfstate"
    region = "ca-central-1"
  }
}
locals {
  name                 = "quizforge-production"
  foundation           = data.terraform_remote_state.foundation.outputs
  hostname             = "api.quizfromnotes.com"
  origin               = "https://quizfromnotes.com"
  domain               = "quizforge-${data.aws_caller_identity.current.account_id}"
  auth_origin          = "https://${local.domain}.auth.ca-central-1.amazoncognito.com"
  legacy_url           = "https://vfxmsvphgcaizqnbyjip.supabase.co"
  csp                  = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://${local.hostname} ${local.auth_origin} https://cognito-idp.ca-central-1.amazonaws.com ${local.legacy_url}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests"
  redis_url            = "rediss://${aws_elasticache_replication_group.cache.primary_endpoint_address}:6379/0"
  ecr_arn              = "arn:aws:ecr:ca-central-1:${data.aws_caller_identity.current.account_id}:repository/quizforge-api"
  assume_ecs           = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  logs                 = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.app.name, awslogs-region = "ca-central-1", awslogs-stream-prefix = "production" } }
  openai_parameter_arn = "arn:aws:ssm:ca-central-1:${data.aws_caller_identity.current.account_id}:parameter/quizforge/prod/OPENAI_API_KEY"
  common_environment = [
    { name = "AUTH_PROVIDER", value = "cognito" },
    { name = "COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.browser.id },
    { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.browser.id },
    { name = "AWS_EC2_METADATA_DISABLED", value = "true" }
  ]
}
resource "aws_cloudwatch_log_group" "app" {
  name              = "/quizforge/production"
  retention_in_days = 14
  lifecycle { prevent_destroy = true }
}
