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
      ALLOWED_ORIGIN = "https://${var.domain}"
    }
  }

  depends_on = [aws_cloudwatch_log_group.blog_api]

  tags = { Project = "personal-website", ManagedBy = "terraform" }
}

resource "aws_cloudwatch_log_group" "blog_api" {
  name              = "/aws/lambda/blog-api"
  retention_in_days = 1

  tags = { Project = "personal-website", ManagedBy = "terraform" }
}
