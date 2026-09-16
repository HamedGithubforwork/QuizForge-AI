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

variable "backend_image_tag" {
  description = "Immutable main-workflow commit tag; excludes staging/rehearsal images."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.backend_image_tag))
    error_message = "Foundation requires a full main-workflow commit image tag."
  }
}
