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

variable "staging_hostname" {
  description = "Optional dedicated staging-api subdomain; never a production hostname."
  type        = string
  default     = ""
  validation {
    condition     = var.staging_hostname == "" || can(regex("^staging-api\\.([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,63}$", var.staging_hostname))
    error_message = "Use a lowercase staging-api subdomain of a domain you control."
  }
}

variable "staging_certificate_arn" {
  description = "Existing issued ACM certificate in ca-central-1; retained outside ephemeral staging."
  type        = string
  default     = ""
  validation {
    condition     = var.staging_certificate_arn == "" || can(regex("^arn:aws:acm:ca-central-1:[0-9]{12}:certificate/[a-f0-9-]{36}$", var.staging_certificate_arn))
    error_message = "Use an ACM certificate ARN in ca-central-1."
  }
}

variable "staging_zone_id" {
  description = "Existing public Route 53 zone for the dedicated staging DNS record."
  type        = string
  default     = ""
  validation {
    condition     = var.staging_zone_id == "" || can(regex("^Z[A-Z0-9]+$", var.staging_zone_id))
    error_message = "Use a Route 53 hosted-zone ID without the /hostedzone/ prefix."
  }
}

locals {
  https_enabled = var.staging_hostname != ""
  tls_inputs_complete = (
    (var.staging_hostname == "" && var.staging_certificate_arn == "" && var.staging_zone_id == "") ||
    (var.staging_hostname != "" && var.staging_certificate_arn != "" && var.staging_zone_id != "")
  )
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
