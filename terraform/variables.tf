variable "bucket_name" {
  # S3 bucket names are global, so this has to be unique.
  type    = string
  default = "tikho-me"
}

variable "domain" {
  type    = string
  default = "tikho.me"
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "terraform_lock_table_name" {
  description = "DynamoDB table name used by the remote Terraform S3 backend for state locking"
  type        = string
  default     = "tikho-me-tf-locks"
}

variable "route53_zone_id" {
  description = "Route53 hosted zone id for the site domain. Required if Terraform should automate alias records."
  type        = string
  default     = ""
}

variable "create_www_redirect" {
  description = "When true, create a DNS alias for www.<domain> too."
  type        = bool
  default     = true
}

variable "acm_certificate_arn" {
  description = "Existing ACM certificate ARN in us-east-1 for the CloudFront custom domain"
  type        = string
}

variable "index_document" { default = "index.html" }
variable "error_document" { default = "index.html" }
