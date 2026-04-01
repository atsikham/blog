terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # The S3 backend can manage a lock file itself now, so a separate
  # DynamoDB lock table is not needed just for state locking.
  backend "s3" {}
}
