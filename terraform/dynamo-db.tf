# On-demand billing is enough here.
# No capacity planning, and a small personal blog will barely touch it.

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

  tags = { Project = "personal-blog", ManagedBy = "terraform" }
}
