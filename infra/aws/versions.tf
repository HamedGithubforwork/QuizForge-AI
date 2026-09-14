terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0, < 7.0"
    }
  }

  # Backend values are supplied by GitHub Actions so the unique state-bucket
  # name is not hard-coded into the repository.
  backend "s3" {}
}
