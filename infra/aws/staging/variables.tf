variable "aws_region" {
  description = "AWS region for the QuizForge staging environment."
  type        = string
  default     = "ca-central-1"
}

variable "backend_image_uri" {
  description = "Optional tested PR image, pinned by ECR digest; staging only."
  type        = string
  default     = ""
  validation {
    condition     = var.backend_image_uri == "" || can(regex("^[0-9]{12}\\.dkr\\.ecr\\.ca-central-1\\.amazonaws\\.com/quizforge-api@sha256:[0-9a-f]{64}$", var.backend_image_uri))
    error_message = "Preview images must be immutable quizforge-api ECR digests in ca-central-1."
  }
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
