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
