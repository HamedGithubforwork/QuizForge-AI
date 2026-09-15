provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

data "terraform_remote_state" "foundation" {
  backend = "s3"

  config = {
    bucket = var.foundation_state_bucket
    key    = "quizforge/foundation/terraform.tfstate"
    region = var.aws_region
  }
}

locals {
  foundation = data.terraform_remote_state.foundation.outputs
}
