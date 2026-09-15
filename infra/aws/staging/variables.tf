variable "aws_region" {
  description = "AWS region for the QuizForge staging environment."
  type        = string
  default     = "ca-central-1"
}

variable "foundation_state_bucket" {
  description = "S3 bucket that stores the QuizForge foundation Terraform state."
  type        = string
}

variable "project_name" {
  description = "Short project identifier used in staging resource names."
  type        = string
  default     = "quizforge"
}

locals {
  common_tags = {
    Project     = "QuizForge AI"
    Environment = "staging"
    ManagedBy   = "Terraform"
    Repository  = "HamedGithubforwork/QuizForge-AI"
    Ephemeral   = "true"
  }
}
