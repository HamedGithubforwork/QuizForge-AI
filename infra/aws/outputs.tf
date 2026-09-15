output "ecr_repository_url" {
  description = "ECR repository URL for the QuizForge API image."
  value       = aws_ecr_repository.api.repository_url
}

output "vpc_id" {
  description = "QuizForge VPC ID."
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "Public subnet IDs reserved for internet-facing infrastructure."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet IDs reserved for application/data services."
  value       = aws_subnet.private[*].id
}

output "alb_security_group_id" {
  description = "Security group reserved for the future application load balancer."
  value       = aws_security_group.alb.id
}

output "app_security_group_id" {
  description = "Security group reserved for the future ECS/FastAPI service."
  value       = aws_security_group.app.id
}

output "data_security_group_id" {
  description = "Security group reserved for future RDS and Redis services."
  value       = aws_security_group.data.id
}

output "api_log_group_name" {
  description = "CloudWatch log group reserved for the API service."
  value       = aws_cloudwatch_log_group.api.name
}

output "ecs_cluster_name" {
  description = "ECS cluster used for the QuizForge API bootstrap."
  value       = aws_ecs_cluster.api.name
}

output "ecs_task_definition_arn" {
  description = "Current ECS Fargate task definition for the QuizForge API."
  value       = aws_ecs_task_definition.api.arn
}

output "ecs_bootstrap_image_uri" {
  description = "Immutable ECR image URI pinned into the current ECS task definition."
  value       = data.aws_ecr_image.api.image_uri
}
