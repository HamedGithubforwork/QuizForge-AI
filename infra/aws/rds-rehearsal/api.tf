# Synthetic API validation only. Password/token versions never enter Terraform.
resource "aws_secretsmanager_secret" "api_application" {
  count                   = var.api_validation ? 1 : 0
  name                    = "${local.name}-api-application"
  recovery_window_in_days = 0
}
resource "aws_secretsmanager_secret" "api_session" {
  count                   = var.api_validation ? 1 : 0
  name                    = "${local.name}-api-session"
  recovery_window_in_days = 0
}
resource "aws_iam_role" "api_setup" {
  count = var.api_validation ? 1 : 0
  name  = "${local.name}-api-setup"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}
resource "aws_iam_role_policy" "api_setup" {
  count = var.api_validation ? 1 : 0
  role  = aws_iam_role.api_setup[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["secretsmanager:PutSecretValue"], Resource = aws_secretsmanager_secret.api_application[0].arn },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.api_session[0].arn }
  ] })
}
resource "aws_iam_role" "api_execution" {
  count = var.api_validation ? 1 : 0
  name  = "${local.name}-api-execution"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}
resource "aws_iam_role_policy" "api_execution" {
  count = var.api_validation ? 1 : 0
  role  = aws_iam_role.api_execution[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"],
    Resource = "arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/quizforge-api" },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"],
    Resource = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:${local.foundation.api_log_group_name}:*" },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"],
    Resource = [aws_secretsmanager_secret.api_application[0].arn, aws_secretsmanager_secret.api_session[0].arn] },
    { Effect = "Allow", Action = ["ssm:GetParameters"], Resource = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/quizforge/prod/SUPABASE_URL",
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/quizforge/prod/SUPABASE_PUBLISHABLE_KEY"
    ] }
  ] })
}
resource "aws_ecs_task_definition" "api" {
  count                    = var.api_validation ? 1 : 0
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.api_execution[0].arn
  # No task role: neither application nor HTTP canary gets AWS credentials.
  container_definitions = jsonencode([
    {
      name                   = "api", essential = true, image = var.api_backend_image
      readonlyRootFilesystem = true, user = "10001:10001"
      linuxParameters        = { capabilities = { drop = ["ALL"] } }
      command                = ["uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8000", "--no-access-log"]
      environment = concat([
        { name = "HISTORY_BACKEND", value = "postgres" },
        { name = "HISTORY_DB_HOST", value = aws_db_instance.source.address },
        { name = "HISTORY_DB_NAME", value = "quizforge_rehearsal" },
        { name = "HISTORY_DB_USER", value = "quizforge_app" },
        { name = "HISTORY_DB_POOL_SIZE", value = "1" },
        { name = "ALLOWED_ORIGINS", value = "https://rds-rehearsal.invalid" }
        ], var.cognito_validation ? [
        { name = "AUTH_PROVIDER", value = "cognito" },
        { name = "COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.rehearsal[0].id },
        { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.rehearsal[0].id }
      ] : [])
      secrets = concat([
        { name = "HISTORY_DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.api_application[0].arn}:password::" }
        ], var.cognito_validation ? [] : [
        { name = "SUPABASE_URL", valueFrom = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/quizforge/prod/SUPABASE_URL" },
        { name = "SUPABASE_PUBLISHABLE_KEY", valueFrom = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/quizforge/prod/SUPABASE_PUBLISHABLE_KEY" }
      ])
      logConfiguration = { logDriver = "awslogs", options = {
        awslogs-group = local.foundation.api_log_group_name, awslogs-region = var.aws_region, awslogs-stream-prefix = "rds-api"
      } }
    },
    {
      name                   = "canary", essential = true, image = var.rehearsal_image
      readonlyRootFilesystem = true, user = "10001:10001"
      linuxParameters        = { capabilities = { drop = ["ALL"] } }
      dependsOn              = [{ containerName = "api", condition = "START" }]
      command                = ["python", "api_canary.py"]
      secrets                = [{ name = "CANARY_SESSION", valueFrom = aws_secretsmanager_secret.api_session[0].arn }]
      logConfiguration = { logDriver = "awslogs", options = {
        awslogs-group = local.foundation.api_log_group_name, awslogs-region = var.aws_region, awslogs-stream-prefix = "rds-api"
      } }
    }
  ])
  lifecycle {
    precondition {
      condition     = var.api_backend_image != "" && var.rehearsal_image != ""
      error_message = "API validation needs the reviewed backend and trusted canary images."
    }
  }
  depends_on = [aws_iam_role_policy.api_execution]
}
