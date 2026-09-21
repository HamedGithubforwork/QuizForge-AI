resource "aws_sns_topic" "alerts" { name = "${local.name}-alerts" }
resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect   = "Allow", Principal = { Service = "budgets.amazonaws.com" }, Action = "SNS:Publish",
      Resource = aws_sns_topic.alerts.arn,
    Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } } },
    { Effect   = "Allow", Principal = { Service = "cloudwatch.amazonaws.com" }, Action = "SNS:Publish",
      Resource = aws_sns_topic.alerts.arn,
    Condition = { StringEquals = { "AWS:SourceOwner" = data.aws_caller_identity.current.account_id } } }
  ] })
}
resource "aws_sns_topic_subscription" "operator" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
resource "aws_budgets_budget" "monthly" {
  name         = "quizforge-monthly-account-cost"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  cost_types {
    include_credit             = false
    include_refund             = false
    include_subscription       = true
    include_recurring          = true
    include_upfront            = true
    include_support            = true
    include_tax                = true
    include_other_subscription = true
  }
  dynamic "notification" {
    for_each = toset([50, 80, 100])
    content {
      comparison_operator       = "GREATER_THAN"
      threshold                 = notification.value
      threshold_type            = "PERCENTAGE"
      notification_type         = "ACTUAL"
      subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
    }
  }
  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }
  depends_on = [aws_sns_topic_policy.alerts]
}
resource "aws_cloudwatch_metric_alarm" "status" {
  alarm_name          = "${local.name}-status-failed"
  namespace           = "QuizForge/Host"
  metric_name         = "Healthy"
  dimensions          = { Deployment = "production-lightsail" }
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_log_group" "recovery" {
  name              = "/aws/lambda/${local.name}-recovery"
  retention_in_days = 14
}
resource "aws_iam_role" "recovery" {
  name = "${local.name}-recovery"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}
resource "aws_lambda_function" "recovery" {
  function_name    = "${local.name}-recovery"
  role             = aws_iam_role.recovery.arn
  runtime          = "python3.13"
  handler          = "identity_triggers.handler"
  filename         = "${path.module}/recovery.zip"
  source_code_hash = filebase64sha256("${path.module}/recovery.zip")
  memory_size      = 128
  timeout          = 5
}
resource "aws_iam_role_policy" "recovery" {
  role = aws_iam_role.recovery.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.recovery.arn}:*" },
    { Effect = "Allow", Action = ["cognito-idp:AdminUserGlobalSignOut"], Resource = aws_cognito_user_pool.browser.arn }
  ] })
}
resource "aws_lambda_permission" "recovery" {
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.recovery.function_name
  principal      = "cognito-idp.amazonaws.com"
  source_arn     = aws_cognito_user_pool.browser.arn
  source_account = data.aws_caller_identity.current.account_id
}

# Attach only to the separate host-health credential, never the API/identity.
resource "aws_iam_policy" "host_health" {
  name = "quizforge-production-host-health"
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow", Action = ["cloudwatch:PutMetricData"], Resource = "*",
    Condition = { StringEquals = { "cloudwatch:namespace" = "QuizForge/Host" } }
  }] })
}
