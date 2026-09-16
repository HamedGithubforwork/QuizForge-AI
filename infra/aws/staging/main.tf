resource "aws_security_group" "valkey" {
  name        = "${var.project_name}-staging-valkey"
  description = "Ephemeral staging Valkey access from the QuizForge application tier"
  vpc_id      = local.foundation.vpc_id

  tags = {
    Name = "${var.project_name}-staging-valkey"
  }
}

resource "aws_vpc_security_group_ingress_rule" "valkey_from_app" {
  security_group_id            = aws_security_group.valkey.id
  referenced_security_group_id = local.foundation.app_security_group_id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  description                  = "Valkey from the ECS application tier"
}

resource "aws_elasticache_subnet_group" "valkey" {
  name       = "${var.project_name}-staging-valkey"
  subnet_ids = local.foundation.private_subnet_ids
}

resource "aws_elasticache_replication_group" "valkey" {
  replication_group_id = "${var.project_name}-staging-valkey"
  description          = "Ephemeral QuizForge staging cache"
  engine               = "valkey"
  node_type            = "cache.t4g.micro"
  num_cache_clusters   = 1
  cluster_mode         = "disabled"
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.valkey.name
  security_group_ids = [aws_security_group.valkey.id]

  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  at_rest_encryption_enabled = true

  automatic_failover_enabled = false
  multi_az_enabled            = false
  snapshot_retention_limit    = 0
  apply_immediately           = true

  tags = {
    Name = "${var.project_name}-staging-valkey"
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.project_name}-api-staging"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = data.aws_iam_role.ecs_task_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = local.foundation.ecs_bootstrap_image_uri
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
        },
        {
          name  = "REDIS_URL"
          value = "rediss://${aws_elasticache_replication_group.valkey.primary_endpoint_address}:6379/0"
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
          name      = "ALLOWED_ORIGINS"
          valueFrom = "${local.parameter_store_prefix}/ALLOWED_ORIGINS"
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = local.foundation.api_log_group_name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs-staging"
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
}

resource "aws_lb" "api" {
  name               = "${var.project_name}-staging-api"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [local.foundation.alb_security_group_id]
  subnets            = local.foundation.public_subnet_ids

  enable_deletion_protection = false

  tags = {
    Name = "${var.project_name}-staging-api"
  }
}

resource "aws_lb_target_group" "api" {
  name        = "${var.project_name}-staging-api"
  port        = 8000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = local.foundation.vpc_id

  deregistration_delay = 10

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
    path                = "/api/health"
    protocol            = "HTTP"
    matcher             = "200"
  }
}

resource "aws_lb_listener" "api_http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_ecs_service" "api" {
  name            = "${var.project_name}-api-staging"
  cluster         = local.foundation.ecs_cluster_name
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 1

  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = 60

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = local.foundation.public_subnet_ids
    security_groups  = [local.foundation.app_security_group_id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8000
  }

  depends_on = [
    aws_lb_listener.api_http,
  ]
}
