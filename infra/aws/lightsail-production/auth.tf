resource "aws_cognito_user_pool" "browser" {
  name                     = local.name
  user_pool_tier           = "LITE"
  deletion_protection      = "ACTIVE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "ON"
  username_configuration { case_sensitive = false }
  admin_create_user_config { allow_admin_create_user_only = !var.public_signup }
  software_token_mfa_configuration { enabled = true }
  user_attribute_update_settings { attributes_require_verification_before_update = ["email"] }
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
resource "aws_cognito_user_pool_domain" "browser" {
  domain                = local.domain
  user_pool_id          = aws_cognito_user_pool.browser.id
  managed_login_version = 1
}
