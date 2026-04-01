resource "aws_s3_bucket" "website" {
  bucket        = var.bucket_name
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
