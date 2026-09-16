output "ecs_cluster_name" {
  description = "ECS cluster hosting the on-demand staging service."
  value       = local.foundation.ecs_cluster_name
}

output "ecs_service_name" {
  description = "On-demand QuizForge staging ECS service name."
  value       = aws_ecs_service.api.name
}

output "ecs_task_definition_arn" {
  description = "Staging task definition wired to the ephemeral Valkey cache."
  value       = aws_ecs_task_definition.api.arn
}

output "public_subnet_ids" {
  description = "Public subnets used by temporary staging Fargate tasks."
  value       = local.foundation.public_subnet_ids
}

output "app_security_group_id" {
  description = "Application security group used by temporary staging Fargate tasks."
  value       = local.foundation.app_security_group_id
}

output "valkey_endpoint" {
  description = "Private TLS endpoint for the ephemeral staging Valkey cache."
  value       = aws_elasticache_serverless_cache.valkey.endpoint[0].address
}

output "api_alb_dns_name" {
  description = "Temporary public DNS name for the staging ALB."
  value       = aws_lb.api.dns_name
}

output "api_http_url" {
  description = "Temporary HTTP staging URL."
  value       = "http://${aws_lb.api.dns_name}"
}
