locals {
  # Terraform writes the live API URL into the frontend config for deploys.
  rendered_config_js = templatefile("${path.root}/../src/js/config.js.tftpl", {
    api_url = aws_apigatewayv2_stage.default.invoke_url
  })

  domain_names = compact([
    var.domain,
    var.create_www_redirect ? "www.${var.domain}" : "",
  ])

  api_allowed_origins = compact([
    "https://${var.domain}",
    var.create_www_redirect ? "https://www.${var.domain}" : "",
    "https://${aws_cloudfront_distribution.cdn.domain_name}",
    "http://localhost:8080",
    "http://localhost:8181",])
}
