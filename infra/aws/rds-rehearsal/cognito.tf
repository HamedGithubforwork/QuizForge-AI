# Disposable synthetic identities only. No production auth cutover or email/SMS.
variable "cognito_validation" {
  type    = bool
  default = false
  validation {
    condition     = !var.cognito_validation || var.api_validation
    error_message = "Cognito rehearsal requires a reviewed API image."
  }
}
resource "aws_cognito_user_pool" "rehearsal" {
  count               = var.cognito_validation ? 1 : 0
  name                = "quizforge-cognito-rehearsal"
  user_pool_tier      = "LITE"
  deletion_protection = "INACTIVE"
  mfa_configuration   = "ON"
  admin_create_user_config {
    allow_admin_create_user_only = true
  }
  software_token_mfa_configuration {
    enabled = true
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
      name     = "admin_only"
      priority = 1
    }
  }
}
resource "aws_cognito_user_pool_client" "rehearsal" {
  count                         = var.cognito_validation ? 1 : 0
  name                          = "quizforge-headless-rehearsal"
  user_pool_id                  = aws_cognito_user_pool.rehearsal[0].id
  generate_secret               = false
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  explicit_auth_flows           = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  read_attributes               = ["email", "email_verified", "sub"]
  write_attributes              = ["email"]
  access_token_validity         = 5
  id_token_validity             = 5
  refresh_token_validity        = 1
  auth_session_validity         = 3
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }
}
