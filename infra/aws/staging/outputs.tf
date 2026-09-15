output "ecs_cluster_name" {
  description = "ECS cluster hosting the on-demand staging service."
  value       = local.foundation.ecs_cluster_name
}

output "ecs_service_name" {
  description = "On-demand QuizForge staging ECS service name."
  value       = aws_ecs_service.api.name
}

output "api_alb_dns_name" {
  description = "Temporary public DNS name for the staging ALB."
  value       = aws_lb.api.dns_name
}

output "api_http_url" {
  description = "Temporary HTTP staging URL."
  value       = "http://${aws_lb.api.dns_name}"
}
