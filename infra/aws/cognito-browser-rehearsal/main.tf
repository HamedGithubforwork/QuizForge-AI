terraform {
  required_version = ">= 1.10.0, < 2.0.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.0, < 7.0" }
  }
  backend "s3" {}
}
provider "aws" {
  region = "ca-central-1"
  default_tags {
    tags = { Project = "QuizForge-AI", Environment = "cognito-browser-rehearsal", Temporary = "true" }
  }
}
data "aws_caller_identity" "current" {}
variable "deadline" {
  type    = string
  default = "1970-01-01T00:00:00Z"
}
variable "recovery_run" {
  type    = string
  default = ""
  validation {
    condition     = var.recovery_run == "" || can(regex("^[0-9]+$", var.recovery_run))
    error_message = "Recovery must be bound to a GitHub Actions run ID."
  }
}
variable "email_sha256" {
  type      = string
  default   = ""
  sensitive = true
  validation {
    condition     = var.email_sha256 == "" || can(regex("^[a-f0-9]{64}$", var.email_sha256))
    error_message = "Only a SHA-256 inbox allowlist digest is accepted."
  }
}
locals {
  name   = "quizforge-cognito-browser-rehearsal"
  domain = "quizforge-browser-${data.aws_caller_identity.current.account_id}"
}
resource "aws_cloudwatch_log_group" "guard" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 1
}
resource "aws_iam_role" "guard" {
  name = local.name
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}
resource "aws_iam_role_policy" "guard" {
  role = aws_iam_role.guard.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect   = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"],
    Resource = "${aws_cloudwatch_log_group.guard.arn}:*"
  }] })
}
resource "aws_lambda_function" "guard" {
  function_name    = local.name
  role             = aws_iam_role.guard.arn
  runtime          = "python3.13"
  handler          = "identity_triggers.handler"
  filename         = "${path.module}/pre_signup.zip"
  source_code_hash = filebase64sha256("${path.module}/pre_signup.zip")
  memory_size      = 128
  timeout          = 5
  environment { variables = { ALLOWED_EMAIL_SHA256 = var.email_sha256 } }
  depends_on = [aws_iam_role_policy.guard]
}
resource "aws_cognito_user_pool" "browser" {
  name                     = local.name
  user_pool_tier           = "LITE"
  deletion_protection      = "INACTIVE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "ON"
  username_configuration { case_sensitive = false }
  admin_create_user_config { allow_admin_create_user_only = false }
  software_token_mfa_configuration { enabled = true }
  email_configuration { email_sending_account = "COGNITO_DEFAULT" }
  verification_message_template {
    default_email_option  = "CONFIRM_WITH_LINK"
    email_subject_by_link = "Verify your temporary QuizForge AWS test account"
    email_message_by_link = "This is the disposable QuizForge AWS migration rehearsal. {##Verify your test email##}. The temporary account will be deleted after validation."
    email_subject         = "Reset your temporary QuizForge AWS test password"
    email_message         = "Your disposable QuizForge recovery test code is {####}. This applies only to the temporary AWS rehearsal account. Never paste this code in chat or workflow inputs."
  }
  user_attribute_update_settings { attributes_require_verification_before_update = ["email"] }
  lambda_config {
    pre_sign_up       = aws_lambda_function.guard.arn
    post_confirmation = aws_lambda_function.guard.arn
  }
  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 1
  }
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}
resource "aws_iam_role_policy" "recovery_revocation" {
  role = aws_iam_role.guard.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect   = "Allow", Action = ["cognito-idp:AdminUserGlobalSignOut"],
    Resource = aws_cognito_user_pool.browser.arn
  }] })
}
resource "aws_lambda_permission" "cognito" {
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.guard.function_name
  principal      = "cognito-idp.amazonaws.com"
  source_arn     = aws_cognito_user_pool.browser.arn
  source_account = data.aws_caller_identity.current.account_id
}
resource "aws_cognito_user_pool_client" "browser" {
  name                                 = "quizforge-browser-pkce"
  user_pool_id                         = aws_cognito_user_pool.browser.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "aws.cognito.signin.user.admin"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["http://localhost:4174/auth/callback"]
  logout_urls                          = ["http://localhost:4174/"]
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  read_attributes                      = ["email", "email_verified", "sub"]
  write_attributes                     = ["email"]
  access_token_validity                = 5
  id_token_validity                    = 5
  refresh_token_validity               = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }
}
resource "aws_cognito_user_pool_client" "fixture" {
  name                          = "quizforge-iam-only-fixture"
  user_pool_id                  = aws_cognito_user_pool.browser.id
  generate_secret               = false
  explicit_auth_flows           = ["ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  read_attributes               = ["email", "email_verified", "sub"]
  write_attributes              = ["email"]
  access_token_validity         = 5
  id_token_validity             = 5
  refresh_token_validity        = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }
}
resource "aws_cognito_user_pool_domain" "browser" {
  domain                = local.domain
  user_pool_id          = aws_cognito_user_pool.browser.id
  managed_login_version = 1
}
output "rehearsal" {
  value = {
    pool           = aws_cognito_user_pool.browser.id, client = aws_cognito_user_pool_client.browser.id,
    fixture_client = aws_cognito_user_pool_client.fixture.id,
    domain         = local.domain, deadline = var.deadline, recovery_run = var.recovery_run
  }
}
