output "website_url" {
  description = "S3 website endpoint — useful for debugging; CloudFront should be the public entry point"
  value       = "http://${aws_s3_bucket_website_configuration.website.website_endpoint}"
}

output "custom_domain" {
  value = "https://${var.domain}"
}

output "bucket_name" {
  value = aws_s3_bucket.website.id
}

output "cloudfront_url" {
  description = "CloudFront URL — custom domain points here through Route53 alias records"
  value       = "https://${aws_cloudfront_distribution.cdn.domain_name}"
}

output "route53_zone_id" {
  description = "Hosted zone id Terraform used for DNS automation. Empty to manage DNS outside Route53."
  value       = var.route53_zone_id
}

output "certificate_arn" {
  description = "ACM certificate used by CloudFront"
  value       = var.acm_certificate_arn
}

output "api_url" {
  description = "Rendered automatically into src/js/config.js for deployed environments"
  value       = aws_apigatewayv2_api.blog_api.api_endpoint
}
