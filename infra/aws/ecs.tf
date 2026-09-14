data "aws_caller_identity" "current" {}

data "aws_ecr_image" "api" {
  repository_name = aws_ecr_repository.api.name
  most_recent     = true
}

data "aws_iam_policy_document" "ecs_task_execution_assume" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "ecs_task_execution" {
  name               = "${var.project_name}-ecs-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_execution_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "ecs_task_execution_parameters" {
  statement {
    effect = "Allow"

    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
    ]

    resources = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/quizforge/prod/*",
    ]
  }
}

resource "aws_iam_role_policy" "ecs_task_execution_parameters" {
  name   = "${var.project_name}-parameter-store"
  role   = aws_iam_role.ecs_task_execution.id
  policy = data.aws_iam_policy_document.ecs_task_execution_parameters.json
}

resource "aws_ecs_cluster" "api" {
  name = "${var.project_name}-api"

  # Container Insights is intentionally left disabled during the bootstrap
  # phase to avoid additional CloudWatch usage while the service is not live.
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

locals {
  parameter_store_prefix = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/quizforge/prod"
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.project_name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = data.aws_ecr_image.api.image_uri
      essential = true

      portMappings = [
        {
          containerPort = 8000
          hostPort      = 8000
          protocol      = "tcp"
        }
      ]

      environment = [
        {
          name  = "LOG_LEVEL"
          value = "INFO"
        }
      ]

      secrets = [
        {
          name      = "OPENAI_API_KEY"
          valueFrom = "${local.parameter_store_prefix}/OPENAI_API_KEY"
        },
        {
          name      = "SUPABASE_URL"
          valueFrom = "${local.parameter_store_prefix}/SUPABASE_URL"
        },
        {
          name      = "SUPABASE_PUBLISHABLE_KEY"
          valueFrom = "${local.parameter_store_prefix}/SUPABASE_PUBLISHABLE_KEY"
        },
        {
          name      = "REDIS_URL"
          valueFrom = "${local.parameter_store_prefix}/REDIS_URL"
        },
        {
          name      = "ALLOWED_ORIGINS"
          valueFrom = "${local.parameter_store_prefix}/ALLOWED_ORIGINS"
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.api.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }

      healthCheck = {
        command = [
          "CMD-SHELL",
          "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=5).read()\"",
        ]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    }
  ])

  depends_on = [
    aws_iam_role_policy_attachment.ecs_task_execution,
    aws_iam_role_policy.ecs_task_execution_parameters,
  ]
}
