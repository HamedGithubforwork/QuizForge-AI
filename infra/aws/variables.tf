variable "aws_region" {
  description = "AWS region for QuizForge infrastructure."
  type        = string
  default     = "ca-central-1"
}

variable "project_name" {
  description = "Short project identifier used in AWS resource names."
  type        = string
  default     = "quizforge"
}

variable "environment" {
  description = "Environment label for shared tags."
  type        = string
  default     = "foundation"
}

locals {
  common_tags = {
    Project     = "QuizForge AI"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Repository  = "HamedGithubforwork/QuizForge-AI"
  }
}
