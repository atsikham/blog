# HTTP API is cheaper and simpler than the older REST API setup.
# One catch-all route is enough because the Lambda handles its own routing.
resource "aws_apigatewayv2_api" "blog_api" {
  name          = "blog-api"
  protocol_type = "HTTP"

  # Localhost is listed so local dev can still talk to the API if needed.
  # Both site domains and the CloudFront domain are allowed in deployed environments.
  cors_configuration {
    allow_origins = local.api_allowed_origins
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

# Explicit routes keep HTTP API routing and CORS preflight predictable.
resource "aws_apigatewayv2_route" "stats" {
  api_id    = aws_apigatewayv2_api.blog_api.id
  route_key = "GET /stats"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "like" {
  api_id    = aws_apigatewayv2_api.blog_api.id
  route_key = "POST /like"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "read" {
  api_id    = aws_apigatewayv2_api.blog_api.id
  route_key = "POST /read"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "comments_get" {
  api_id    = aws_apigatewayv2_api.blog_api.id
  route_key = "GET /comments"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "comments_post" {
  api_id    = aws_apigatewayv2_api.blog_api.id
  route_key = "POST /comments"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.blog_api.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 20
  }

  # Tighter limits on the write routes that cost
  route_settings {
    route_key              = "POST /comments"
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }

  route_settings {
    route_key              = "POST /like"
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }

  route_settings {
    route_key              = "POST /read"
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.blog_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.blog_api.execution_arn}/*/*"
}
