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
  task_definition = local.foundation.ecs_task_definition_arn
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
