# infra for tikho.me — see README.adoc for the full deploy flow

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

locals {
  # Terraform writes the live API URL into the frontend config for deploys.
  rendered_config_js = templatefile("${path.root}/../src/js/config.js.tftpl", {
    api_url = aws_apigatewayv2_stage.default.invoke_url
  })

  domain_names = compact([
    var.domain,
    var.create_www_redirect ? "www.${var.domain}" : "",
  ])
}

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

provider "aws" {
  region = var.region
}

# ── S3 ────────────────────────────────────────────────────────

resource "aws_s3_bucket" "website" {
  bucket        = var.bucket_name
  # Handy for demos and rebuilds. It lets terraform destroy remove the bucket
  # even if files are still inside it.
  force_destroy = true

  tags = {
    Project   = "personal-website"
    ManagedBy = "terraform"
  }
}

resource "aws_s3_bucket_website_configuration" "website" {
  bucket = aws_s3_bucket.website.id

  index_document { suffix = var.index_document }
  error_document { key    = var.error_document }
}

# Public website buckets need these blocks turned off explicitly.
resource "aws_s3_bucket_public_access_block" "website" {
  bucket = aws_s3_bucket.website.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "public_read" {
  bucket     = aws_s3_bucket.website.id
  depends_on = [aws_s3_bucket_public_access_block.website]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadGetObject"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.website.arn}/*"
    }]
  })
}

# The deployed site should always point at the real API URL.
# Terraform renders this file and uploads it directly.
resource "aws_s3_object" "config_js" {
  bucket       = aws_s3_bucket.website.id
  key          = "src/js/config.js"
  content      = local.rendered_config_js
  content_type = "application/javascript"

  tags = {
    Project   = "personal-website"
    ManagedBy = "terraform"
  }
}

output "website_url" {
  description = "S3 website endpoint — mostly useful for debugging; CloudFront should be the public entry point"
  value       = "http://${aws_s3_bucket_website_configuration.website.website_endpoint}"
}

output "custom_domain" {
  value = "https://${var.domain}"
}

output "bucket_name" {
  value = aws_s3_bucket.website.id
}

output "terraform_lock_table_name" {
  description = "Legacy output name kept for compatibility; S3 lockfiles are used for backend locking now"
  value       = var.terraform_lock_table_name
}

# ── Route53 ───────────────────────────────────────────────────

# The ACM certificate already exists, so Terraform only needs to manage the
# alias records if the domain zone lives in Route53.

# ── DynamoDB ───────────────────────────────────────────────────

# On-demand billing is enough here.
# No capacity planning, and a small personal site will barely touch it.

# This table stays in the stack for compatibility, but Terraform backend
# locking now uses S3 lockfiles instead of DynamoDB.
resource "aws_dynamodb_table" "terraform_locks" {
  name         = var.terraform_lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = { Project = "personal-website", ManagedBy = "terraform", Purpose = "terraform-state-lock" }
}

# One row per post for likes and reads.
resource "aws_dynamodb_table" "post_stats" {
  name         = "blog_post_stats"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "postId"

  attribute {
    name = "postId"
    type = "S"
  }

  tags = { Project = "personal-website", ManagedBy = "terraform" }
}

# Comments use postId + sk.
# sk is "createdAt#uuid", so comments stay in time order and still stay unique.
resource "aws_dynamodb_table" "comments" {
  name         = "blog_comments"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "postId"
  range_key    = "sk"

  attribute {
    name = "postId"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  tags = { Project = "personal-website", ManagedBy = "terraform" }
}

# ── IAM ────────────────────────────────────────────────────────

# The Lambda only gets what it needs: logs plus the two DynamoDB tables.
resource "aws_iam_role" "lambda" {
  name = "blog-api-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "lambda_policy" {
  name = "blog-api-lambda-policy"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.post_stats.arn,
          aws_dynamodb_table.comments.arn,
        ]
      }
    ]
  })
}

# ── Lambda ─────────────────────────────────────────────────────

# The backend is small enough that one Python Lambda is enough.
# Build lambda.zip from ../lambda before terraform apply.
resource "aws_lambda_function" "blog_api" {
  function_name    = "blog-api"
  filename         = "${path.module}/lambda.zip"
  source_code_hash = fileexists("${path.module}/lambda.zip") ? filebase64sha256("${path.module}/lambda.zip") : null
  handler          = "index.handler"
  runtime          = "python3.12"
  role             = aws_iam_role.lambda.arn
  timeout          = 10
  memory_size      = 128

  environment {
    variables = {
      STATS_TABLE    = aws_dynamodb_table.post_stats.name
      COMMENTS_TABLE = aws_dynamodb_table.comments.name
      # API Gateway also has CORS config, but keeping it in the Lambda too
      # makes direct responses consistent.
      ALLOWED_ORIGIN = "https://${var.domain}"
    }
  }

  tags = { Project = "personal-website", ManagedBy = "terraform" }
}

# ── API Gateway ────────────────────────────────────────────────

# HTTP API is cheaper and simpler than the older REST API setup.
# One catch-all route is enough because the Lambda handles its own routing.
resource "aws_apigatewayv2_api" "blog_api" {
  name          = "blog-api"
  protocol_type = "HTTP"

  # Localhost is listed so local dev can still talk to the API if needed.
  # The CloudFront domain is listed too for the deployed site.
  cors_configuration {
    allow_origins = [
      "https://${var.domain}",
      "https://${aws_cloudfront_distribution.cdn.domain_name}",
      "http://localhost:8080",
      "http://localhost:8181",
    ]
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["Content-Type"]
    max_age       = 86400
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.blog_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.blog_api.invoke_arn
  payload_format_version = "2.0"
}

# One route catches everything and passes it to the Lambda.
resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.blog_api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.blog_api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.blog_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.blog_api.execution_arn}/*/*"
}

output "api_url" {
  description = "rendered automatically into src/js/config.js for deployed environments"
  value       = aws_apigatewayv2_stage.default.invoke_url
}

# ── CloudFront ─────────────────────────────────────────────────

resource "aws_cloudfront_distribution" "cdn" {
  enabled             = true
  aliases             = local.domain_names
  default_root_object = "index.html"

  origin {
    domain_name = aws_s3_bucket_website_configuration.website.website_endpoint
    origin_id   = "s3-website"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "s3-website"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 86400
    max_ttl     = 31536000
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  # This keeps the SPA working when someone refreshes on /#post-1 or another client route.
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  tags = { Project = "personal-website", ManagedBy = "terraform" }
}

resource "aws_route53_record" "site_alias" {
  for_each = var.route53_zone_id == "" ? tomap({}) : tomap({
    for domain_name in local.domain_names : domain_name => domain_name
  })

  zone_id = var.route53_zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.cdn.domain_name
    zone_id                = aws_cloudfront_distribution.cdn.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "site_alias_ipv6" {
  for_each = var.route53_zone_id == "" ? {} : toset(local.domain_names)

  zone_id = var.route53_zone_id
  name    = each.value
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.cdn.domain_name
    zone_id                = aws_cloudfront_distribution.cdn.hosted_zone_id
    evaluate_target_health = false
  }
}

output "cloudfront_url" {
  description = "CloudFront URL — custom domain should point here through Route53 alias records"
  value       = "https://${aws_cloudfront_distribution.cdn.domain_name}"
}

output "route53_zone_id" {
  description = "Hosted zone id Terraform used for DNS automation. Leave empty to manage DNS outside Route53."
  value       = var.route53_zone_id
}

output "certificate_arn" {
  description = "ACM certificate used by CloudFront"
  value       = var.acm_certificate_arn
}
