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
