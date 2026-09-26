locals {
  cognito_sms_external_id = "quizforge-production-sms-mfa-v1"
}

resource "aws_iam_role" "cognito_sms" {
  name = "quizforge-production-cognito-sms"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "cognito-idp.amazonaws.com" }
      Action = "sts:AssumeRole"
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          "sts:ExternalId"    = local.cognito_sms_external_id
        }
        ArnLike = {
          "aws:SourceArn" = "arn:aws:cognito-idp:ca-central-1:${data.aws_caller_identity.current.account_id}:userpool/*"
        }
      }
    }]
  })

  lifecycle { prevent_destroy = true }
  depends_on = [aws_iam_role_policy.cognito_sms]
}

resource "aws_iam_role_policy" "cognito_sms" {
  name = "quizforge-production-cognito-sms-publish"
  role = aws_iam_role.cognito_sms.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sns:Publish"]
      Resource = "*"
    }]
  })
}

resource "aws_cognito_user_pool" "browser" {
  name                     = local.name
  user_pool_tier           = "LITE"
  deletion_protection      = "ACTIVE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email", "phone_number"]
  mfa_configuration        = "ON"
  username_configuration { case_sensitive = false }
  admin_create_user_config { allow_admin_create_user_only = !var.public_signup }
  sms_authentication_message = "Your Quiz From Notes sign-in code is {####}"

  sms_configuration {
    external_id    = local.cognito_sms_external_id
    sns_caller_arn = aws_iam_role.cognito_sms.arn
    sns_region     = "ca-central-1"
  }

  software_token_mfa_configuration { enabled = true }
  user_attribute_update_settings { attributes_require_verification_before_update = ["email", "phone_number"] }
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
  # Low-volume public launch uses Cognito's limited, AWS-managed email sender.
  # Real inbox verification and recovery delivery were rehearsed before enabling signup.
  email_configuration { email_sending_account = "COGNITO_DEFAULT" }
  verification_message_template { default_email_option = "CONFIRM_WITH_CODE" }
  lambda_config { post_confirmation = aws_lambda_function.recovery.arn }
  lifecycle { prevent_destroy = true }
}
resource "aws_cognito_user_pool_client" "browser" {
  name                                 = "quizforge-production-pkce"
  user_pool_id                         = aws_cognito_user_pool.browser.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "aws.cognito.signin.user.admin"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["${local.origin}/auth/callback"]
  logout_urls                          = ["${local.origin}/"]
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_PASSWORD_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  read_attributes                      = ["email", "email_verified", "phone_number", "phone_number_verified", "sub"]
  write_attributes                     = ["email", "phone_number"]
  access_token_validity                = 5
  id_token_validity                    = 5
  refresh_token_validity               = 1
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
