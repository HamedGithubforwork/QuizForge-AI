mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
}

variables {
  monthly_budget_usd = 20
  alert_email        = "synthetic@example.com"
  ssh_public_key     = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakesynthetickeyonly"
  admin_ipv4_cidr    = "192.0.2.10/32"
}
run "permanent_host_private_ports_auth_and_cost_controls" {
  command = plan
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }
  override_resource {
    target          = aws_sns_topic.alerts
    override_during = plan
    values          = { arn = "arn:aws:sns:ca-central-1:123456789012:quizforge-production-lightsail-alerts" }
  }
  assert {
    condition     = aws_lightsail_instance.server.bundle_id == "small_3_0" && aws_lightsail_instance.server.blueprint_id == "ubuntu_24_04" && aws_lightsail_instance.server.ip_address_type == "ipv4"
    error_message = "Retain the measured 2 GB / 2 vCPU IPv4 Ubuntu layout."
  }
  assert {
    condition     = length(aws_lightsail_instance_public_ports.server.port_info) == 3 && alltrue([for p in aws_lightsail_instance_public_ports.server.port_info : contains([22, 80, 443], p.from_port) && p.from_port == p.to_port && p.protocol == "tcp" && (p.from_port != 22 || (length(p.cidrs) == 1 && contains(p.cidrs, "192.0.2.10/32")))])
    error_message = "Only HTTP/HTTPS and one operator SSH source may be public."
  }
  assert {
    condition     = aws_cognito_user_pool.browser.admin_create_user_config[0].allow_admin_create_user_only && aws_cognito_user_pool.browser.deletion_protection == "ACTIVE" && aws_cognito_user_pool.browser.mfa_configuration == "ON"
    error_message = "Public signup starts disabled; retained identity and MFA remain required."
  }
  assert {
    condition     = aws_cognito_user_pool_client.browser.callback_urls == toset(["https://quizfromnotes.com/auth/callback"]) && !aws_cognito_user_pool_client.browser.generate_secret
    error_message = "PKCE redirects must remain bound to the canonical HTTPS website."
  }
  assert {
    condition     = aws_budgets_budget.monthly.limit_amount == "20" && length(aws_budgets_budget.monthly.notification) == 4 && !aws_budgets_budget.monthly.cost_types[0].include_credit
    error_message = "Use the explicit account-wide gross-cost alert threshold."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.status.treat_missing_data == "breaching" && aws_cloudwatch_metric_alarm.status.namespace == "QuizForge/Host"
    error_message = "A dead host must trigger the independent missing-heartbeat alarm."
  }
  assert {
    condition     = jsondecode(aws_iam_policy.host_health.policy).Statement[0].Condition.StringEquals["cloudwatch:namespace"] == "QuizForge/Host"
    error_message = "Host health authority must be confined to its own metrics namespace."
  }
}
run "reject_open_ssh" {
  command = plan
  variables { admin_ipv4_cidr = "0.0.0.0/0" }
  expect_failures = [var.admin_ipv4_cidr]
}
run "reject_placeholder_recipient" {
  command = plan
  variables { alert_email = "operator@example.invalid" }
  expect_failures = [var.alert_email]
}
