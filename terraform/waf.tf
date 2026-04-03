# Costs ~$8/month fixed ($5 ACL + $1/rule × 3 rules) regardless of traffic.
# Not worth it for a personal blog — API GW throttling + Lambda rate limiting
# already cover the realistic threats.
#
# resource "aws_wafv2_web_acl" "api" {
#   name  = "blog-api-waf"
#   scope = "REGIONAL"
#
#   default_action {
#     allow {}
#   }
#
#   # Max 500 requests per 5-minute window per IP.
#   rule {
#     name     = "RateLimitPerIP"
#     priority = 1
#     action { block {} }
#     statement {
#       rate_based_statement {
#         limit              = 500
#         aggregate_key_type = "IP"
#       }
#     }
#     visibility_config {
#       cloudwatch_metrics_enabled = true
#       metric_name                = "RateLimitPerIP"
#       sampled_requests_enabled   = true
#     }
#   }
#
#   # Block bodies larger than 8 KB — a comment is never that big.
#   rule {
#     name     = "BlockOversizedBodies"
#     priority = 2
#     action { block {} }
#     statement {
#       size_constraint_statement {
#         comparison_operator = "GT"
#         size                = 8192
#         field_to_match { body { oversize_handling = "MATCH" } }
#         text_transformation { priority = 0; type = "NONE" }
#       }
#     }
#     visibility_config {
#       cloudwatch_metrics_enabled = true
#       metric_name                = "BlockOversizedBodies"
#       sampled_requests_enabled   = true
#     }
#   }
#
#   # AWS managed rule set — catches SQLi, XSS, and other common exploits.
#   rule {
#     name     = "AWSManagedRulesCommonRuleSet"
#     priority = 3
#     override_action { none {} }
#     statement {
#       managed_rule_group_statement {
#         name        = "AWSManagedRulesCommonRuleSet"
#         vendor_name = "AWS"
#       }
#     }
#     visibility_config {
#       cloudwatch_metrics_enabled = true
#       metric_name                = "AWSManagedRulesCommonRuleSet"
#       sampled_requests_enabled   = true
#     }
#   }
#
#   visibility_config {
#     cloudwatch_metrics_enabled = true
#     metric_name                = "blog-api-waf"
#     sampled_requests_enabled   = true
#   }
#
#   tags = { Project = "personal-website", ManagedBy = "terraform" }
# }
#
# resource "aws_wafv2_web_acl_association" "api" {
#   resource_arn = "${aws_apigatewayv2_api.blog_api.arn}/stages/${aws_apigatewayv2_stage.default.name}"
#   web_acl_arn  = aws_wafv2_web_acl.api.arn
# }
