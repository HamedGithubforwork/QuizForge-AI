resource "aws_secretsmanager_secret" "generation" {
  name                    = "${local.name}-generation"
  recovery_window_in_days = 30
  lifecycle { prevent_destroy = true }
}
resource "aws_iam_role_policy" "generation_secret" {
  role = aws_iam_role.execution["api"].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ssm:GetParameters"], Resource = local.openai_parameter_arn },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.generation.arn }
  ] })
}
resource "aws_sns_topic" "alerts" { name = "${local.name}-alerts" }
resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    {
      Effect    = "Allow", Principal = { Service = ["budgets.amazonaws.com", "cloudwatch.amazonaws.com"] },
      Action    = "SNS:Publish", Resource = aws_sns_topic.alerts.arn,
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }
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
  # Account-wide, before credits: tags and credit offsets cannot hide spend.
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
resource "aws_cloudwatch_metric_alarm" "database_storage" {
  alarm_name          = "${local.name}-database-storage"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "LessThanThreshold"
  threshold           = 3221225472
  treat_missing_data  = "breaching"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.db.identifier }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_metric_alarm" "unhealthy" {
  for_each            = aws_lb_target_group.app
  alarm_name          = "${local.name}-${each.key}-unhealthy"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  dimensions          = { LoadBalancer = aws_lb.api.arn_suffix, TargetGroup = each.value.arn_suffix }
  alarm_actions       = var.enable_api ? [aws_sns_topic.alerts.arn] : []
}
resource "aws_cloudwatch_metric_alarm" "api_errors" {
  alarm_name          = "${local.name}-server-errors"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 10
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = aws_lb.api.arn_suffix }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_metric_alarm" "cache_memory" {
  alarm_name          = "${local.name}-cache-memory"
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = 85
  treat_missing_data  = "missing"
  dimensions          = { CacheClusterId = "${local.name}-001", CacheNodeId = "0001" }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
