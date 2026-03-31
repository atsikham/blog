import json
import os
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError

os.environ["STATS_TABLE"] = "blog_post_stats"
os.environ["COMMENTS_TABLE"] = "blog_comments"
os.environ["ALLOWED_ORIGIN"] = "https://tikho.me"

import index  # noqa: E402


def event(method, path, body=None, qs=None):
    return {
        "requestContext": {"http": {"method": method}},
        "rawPath": path,
        "queryStringParameters": qs or {},
        "body": json.dumps(body) if body is not None else None,
        "isBase64Encoded": False,
    }


@pytest.fixture(autouse=True)
def reset_tables():
    stats = Mock()
    comments = Mock()
    index._set_tables_for_tests(stats, comments)
    yield stats, comments


def test_sanitize_text_strips_html_and_caps_length():
    assert index.sanitize_text("  <b>Hello</b>  ", 20) == "Hello"
    assert index.sanitize_text("x" * 10, 5) == "xxxxx"


def test_parse_body_handles_empty_and_invalid_json():
    assert index.parse_body({"body": None, "isBase64Encoded": False}) == {}
    with pytest.raises(ValueError, match="Invalid JSON"):
        index.parse_body({"body": "{bad", "isBase64Encoded": False})


def test_options_returns_204():
    response = index.handler(event("OPTIONS", "/like"), None)
    assert response["statusCode"] == 204
    assert response["headers"]["Access-Control-Allow-Origin"] == "https://tikho.me"


def test_get_stats_returns_rows(reset_tables):
    stats, _ = reset_tables

    def get_item(Key):
        if Key["postId"] == "post-1":
            return {"Item": {"likes": 5, "reads": 42}}
        return {}

    stats.get_item.side_effect = get_item

    response = index.handler(event("GET", "/stats", qs={"postIds": "post-1,post-2"}), None)
    assert response["statusCode"] == 200
    body = json.loads(response["body"])
    assert {"id": "post-1", "likes": 5, "reads": 42} in body
    assert {"id": "post-2", "likes": 0, "reads": 0} in body


def test_get_stats_requires_post_ids():
    response = index.handler(event("GET", "/stats"), None)
    assert response["statusCode"] == 400


def test_post_like_increments(reset_tables):
    stats, _ = reset_tables
    stats.update_item.return_value = {"Attributes": {"likes": 3}}

    response = index.handler(event("POST", "/like", {"postId": "post-1", "liked": True}), None)
    assert response["statusCode"] == 200
    assert json.loads(response["body"])["likes"] == 3


def test_post_like_decrement_floors_at_zero(reset_tables):
    stats, _ = reset_tables
    stats.update_item.side_effect = ClientError(
        {"Error": {"Code": "ConditionalCheckFailedException", "Message": "already zero"}},
        "UpdateItem",
    )

    response = index.handler(event("POST", "/like", {"postId": "post-1", "liked": False}), None)
    assert response["statusCode"] == 200
    assert json.loads(response["body"])["likes"] == 0


def test_post_like_requires_post_id():
    response = index.handler(event("POST", "/like", {}), None)
    assert response["statusCode"] == 400


def test_post_read_increments(reset_tables):
    stats, _ = reset_tables
    stats.update_item.return_value = {"Attributes": {"reads": 10}}

    response = index.handler(event("POST", "/read", {"postId": "post-1"}), None)
    assert response["statusCode"] == 200
    assert json.loads(response["body"])["reads"] == 10


def test_get_comments_returns_formatted_list(reset_tables):
    _, comments = reset_tables
    comments.query.return_value = {
        "Items": [
            {
                "id": "abc",
                "name": "Anatoli",
                "text": "nice post",
                "replyToId": "parent-1",
                "createdAt": "2026-01-15T10:00:00Z",
            }
        ]
    }

    response = index.handler(event("GET", "/comments", qs={"postId": "post-1"}), None)
    assert response["statusCode"] == 200
    body = json.loads(response["body"])
    assert body[0]["name"] == "Anatoli"
    assert body[0]["text"] == "nice post"
    assert body[0]["replyToId"] == "parent-1"
    assert body[0]["date"]


def test_get_comments_requires_post_id():
    response = index.handler(event("GET", "/comments"), None)
    assert response["statusCode"] == 400


def test_post_comment_saves_and_returns_comment(reset_tables):
    _, comments = reset_tables

    response = index.handler(
        event("POST", "/comments", {"postId": "post-1", "name": "Anatoli", "text": "great article"}),
        None,
    )
    assert response["statusCode"] == 200
    body = json.loads(response["body"])
    assert body["name"] == "Anatoli"
    assert body["text"] == "great article"
    assert body["replyToId"] is None
    comments.put_item.assert_called_once()


def test_post_comment_preserves_reply_id():
    response = index.handler(
        event("POST", "/comments", {"postId": "post-1", "name": "Anatoli", "text": "reply", "replyToId": "parent-123"}),
        None,
    )
    assert response["statusCode"] == 200
    assert json.loads(response["body"])["replyToId"] == "parent-123"


def test_post_comment_strips_html():
    response = index.handler(
        event("POST", "/comments", {"postId": "post-1", "name": "<script>xss</script>", "text": "hello <b>world</b>"}),
        None,
    )
    body = json.loads(response["body"])
    assert body["name"] == "xss"
    assert body["text"] == "hello world"


def test_post_comment_requires_fields():
    response = index.handler(event("POST", "/comments", {"postId": "post-1"}), None)
    assert response["statusCode"] == 400


def test_invalid_json_returns_400():
    response = index.handler(
        {
            "requestContext": {"http": {"method": "POST"}},
            "rawPath": "/comments",
            "queryStringParameters": {},
            "body": "{not-json",
            "isBase64Encoded": False,
        },
        None,
    )
    assert response["statusCode"] == 400
    assert json.loads(response["body"])["error"] == "Invalid JSON"


def test_unknown_route_returns_404():
    response = index.handler(event("GET", "/unknown"), None)
    assert response["statusCode"] == 404
