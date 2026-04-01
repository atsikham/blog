"""Blog API Lambda.

Handles likes, reads and comments for the site.
Routes:
- GET /stats
- POST /like
- POST /read
- GET /comments
- POST /comments
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import logging
import os
import re
import uuid
from typing import Any, Callable

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

STATS_TABLE = os.environ.get("STATS_TABLE", "blog_post_stats")
COMMENTS_TABLE = os.environ.get("COMMENTS_TABLE", "blog_comments")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")

logger.info(
    "Lambda module loaded",
    extra={
        "stats_table": STATS_TABLE,
        "comments_table": COMMENTS_TABLE,
        "allowed_origin": ALLOWED_ORIGIN,
    },
)

# Same CORS headers on every response.
# This keeps the browser happy whether the site is using the local fallback
# or the deployed API behind CloudFront.
CORS = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

_dynamodb = None
_stats_table = None
_comments_table = None


def _get_tables() -> tuple[Any, Any]:
    global _dynamodb, _stats_table, _comments_table
    # Create the DynamoDB resource lazily.
    # That keeps imports cheap and makes tests easy to stub.
    if _stats_table is None or _comments_table is None:
        if _dynamodb is None:
            logger.info("Creating DynamoDB resource")
            _dynamodb = boto3.resource("dynamodb")
        _stats_table = _dynamodb.Table(STATS_TABLE)
        _comments_table = _dynamodb.Table(COMMENTS_TABLE)
    return _stats_table, _comments_table


def _set_tables_for_tests(stats_table: Any, comments_table: Any) -> None:
    global _stats_table, _comments_table
    _stats_table = stats_table
    _comments_table = comments_table


def json_response(status_code: int, body: Any, extra_headers: dict[str, str] | None = None) -> dict[str, Any]:
    headers = {**CORS, "Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    return {"statusCode": status_code, "headers": headers, "body": json.dumps(body)}


def ok(body: Any) -> dict[str, Any]:
    return json_response(200, body)


def err(status_code: int, message: str) -> dict[str, Any]:
    return json_response(status_code, {"error": message})


def parse_body(event: dict[str, Any]) -> dict[str, Any]:
    body = event.get("body")
    if not body:
        return {}
    try:
        # API Gateway can pass the body through as base64.
        # Decode it first if that flag is set.
        if event.get("isBase64Encoded"):
            body = base64.b64decode(body).decode("utf-8")
        return json.loads(body)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("Invalid JSON") from exc


_TAG_RE = re.compile(r"<[^>]*>")


def sanitize_text(value: Any, max_len: int = 1000) -> str:
    # Comments are plain text.
    # Strip tags, trim space, and cap length so one bad payload does not bloat the row.
    return _TAG_RE.sub("", str(value)).strip()[:max_len]


def _format_date(iso_value: str) -> str:
    date = dt.datetime.fromisoformat(iso_value.replace("Z", "+00:00"))
    return f"{date.strftime('%b')} {date.day}, {date.year}"


def get_stats(post_id: str) -> dict[str, int]:
    stats_table, _ = _get_tables()
    item = stats_table.get_item(Key={"postId": post_id}).get("Item")
    # New posts do not have a row yet.
    # Treat that as zeroes instead of a missing-resource error.
    if not item:
        return {"likes": 0, "reads": 0}
    return {
        "likes": int(item.get("likes", 0) or 0),
        "reads": int(item.get("reads", 0) or 0),
    }


def increment(post_id: str, field: str, delta: int = 1) -> int:
    stats_table, _ = _get_tables()
    # DynamoDB ADD is handy here: it creates the number if missing,
    # then increments it in one write.
    response = stats_table.update_item(
        Key={"postId": post_id},
        UpdateExpression="ADD #f :d",
        ExpressionAttributeNames={"#f": field},
        ExpressionAttributeValues={":d": delta},
        ReturnValues="UPDATED_NEW",
    )
    return int(response["Attributes"][field])


def handle_get_stats(event: dict[str, Any]) -> dict[str, Any]:
    raw = (event.get("queryStringParameters") or {}).get("postIds", "")
    post_ids = [part.strip() for part in raw.split(",") if part.strip()]
    if not post_ids:
        return err(400, "postIds required")

    rows = []
    for post_id in post_ids:
        rows.append({"id": post_id, **get_stats(post_id)})
    return ok(rows)


def handle_toggle_like(body: dict[str, Any]) -> dict[str, Any]:
    stats_table, _ = _get_tables()
    post_id = body.get("postId")
    liked = body.get("liked")
    if not post_id:
        return err(400, "postId required")

    if liked:
        new_count = increment(post_id, "likes", 1)
    else:
        try:
            # Only decrement if the stored count is already above zero.
            response = stats_table.update_item(
                Key={"postId": post_id},
                UpdateExpression="ADD likes :d",
                ConditionExpression="likes > :zero",
                ExpressionAttributeValues={":d": -1, ":zero": 0},
                ReturnValues="UPDATED_NEW",
            )
            new_count = int(response["Attributes"]["likes"])
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                new_count = 0
            else:
                raise

    return ok({"postId": post_id, "likes": new_count})


def handle_record_read(body: dict[str, Any]) -> dict[str, Any]:
    post_id = body.get("postId")
    if not post_id:
        return err(400, "postId required")
    new_count = increment(post_id, "reads", 1)
    return ok({"postId": post_id, "reads": new_count})


def handle_get_comments(event: dict[str, Any]) -> dict[str, Any]:
    _, comments_table = _get_tables()
    post_id = (event.get("queryStringParameters") or {}).get("postId")
    if not post_id:
        return err(400, "postId required")

    # Comments are stored under one post id and sorted by the range key.
    # That gives a stable oldest-first list for the UI.
    response = comments_table.query(KeyConditionExpression=Key("postId").eq(post_id), ScanIndexForward=True)
    items = response.get("Items", [])
    comments = [
        {
            "id": item["id"],
            "name": item["name"],
            "text": item["text"],
            "replyToId": item.get("replyToId"),
            "date": _format_date(item["createdAt"]),
        }
        for item in items
    ]
    return ok(comments)


def handle_add_comment(body: dict[str, Any]) -> dict[str, Any]:
    _, comments_table = _get_tables()
    post_id = body.get("postId")
    name = body.get("name")
    text = body.get("text")
    reply_to_id = body.get("replyToId")

    if not post_id or not name or not text:
        return err(400, "postId, name and text required")

    safe_name = sanitize_text(name, 80)
    safe_text = sanitize_text(text, 1000)
    safe_reply_to_id = str(reply_to_id)[:200] if reply_to_id else None

    comment_id = str(uuid.uuid4())
    created_at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    # The sort key keeps comments ordered by time and still guarantees uniqueness.
    sort_key = f"{created_at}#{comment_id}"

    item = {
        "postId": post_id,
        "sk": sort_key,
        "id": comment_id,
        "name": safe_name,
        "text": safe_text,
        "createdAt": created_at,
    }
    if safe_reply_to_id:
        item["replyToId"] = safe_reply_to_id

    comments_table.put_item(Item=item)

    return ok(
        {
            "id": comment_id,
            "name": safe_name,
            "text": safe_text,
            "replyToId": safe_reply_to_id,
            "date": _format_date(created_at),
        }
    )


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    method = ((event.get("requestContext") or {}).get("http") or {}).get("method")
    path = event.get("rawPath", "/")

    logger.info("Handling request", extra={"method": method, "path": path})

    if method == "OPTIONS":
        return {"statusCode": 204, "headers": CORS, "body": ""}

    try:
        body = parse_body(event)
    except ValueError:
        return err(400, "Invalid JSON")

    # Keep the routing table small and obvious.
    # GET handlers need the full event because they read query params.
    routes: dict[tuple[str, str], Callable[[dict[str, Any]], dict[str, Any]]] = {
        ("GET", "/stats"): handle_get_stats,
        ("POST", "/like"): handle_toggle_like,
        ("POST", "/read"): handle_record_read,
        ("GET", "/comments"): handle_get_comments,
        ("POST", "/comments"): handle_add_comment,
    }

    route = routes.get((method, path))
    if not route:
        return err(404, "Not found")

    try:
        return route(event if method == "GET" else body)
    except Exception as exc:
        logger.exception(
            "Unhandled error while processing request: %s",
            exc,
            extra={"method": method, "path": path},
        )
        return err(500, "Internal server error")
