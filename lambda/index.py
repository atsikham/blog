"""Blog API Lambda — handles likes, reads, and comments.

Routes:
  GET  /stats
  POST /like
  POST /read
  GET  /comments
  POST /comments
"""

from __future__ import annotations

import base64
import collections
import datetime as dt
import json
import logging
import os
import re
import time
import uuid
from typing import Any, Callable

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

STATS_TABLE    = os.environ.get("STATS_TABLE",    "blog_post_stats")
COMMENTS_TABLE = os.environ.get("COMMENTS_TABLE", "blog_comments")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")

# Anything bigger than this is almost certainly not a legitimate comment.
# The WAF already rejects oversized bodies, but I'd rather not trust that alone.
MAX_BODY_BYTES = 8_192

# Sliding-window rate limits per (IP, route).
# Lambda containers live for a while, so this in-process store is actually
# useful — it accumulates timestamps across warm invocations.
# The limits are tight enough to stop bots but loose enough that a real user
# won't notice them.
_RATE_LIMITS: dict[str, tuple[int, int]] = {
    # (max requests, window in seconds)
    "POST /comments": (5,  600),  # 5 comments per 10 min
    "POST /like":     (30,  60),  # 30 likes per minute feels like plenty
    "POST /read":     (60,  60),  # reads are cheap but still worth capping
}

_rate_store: dict[tuple[str, str], collections.deque] = collections.defaultdict(collections.deque)


def _check_rate_limit(ip: str, route_key: str) -> bool:
    limit = _RATE_LIMITS.get(route_key)
    if not limit or not ip:
        return True
    max_req, window = limit
    now = time.monotonic()
    bucket = _rate_store[(ip, route_key)]
    while bucket and bucket[0] < now - window:
        bucket.popleft()
    if len(bucket) >= max_req:
        return False
    bucket.append(now)
    return True


def _get_ip(event: dict[str, Any]) -> str:
    return (
        (event.get("requestContext") or {})
        .get("http", {})
        .get("sourceIp", "")
    )


logger.info(
    "Lambda cold start",
    extra={
        "stats_table":    STATS_TABLE,
        "comments_table": COMMENTS_TABLE,
        "allowed_origin": ALLOWED_ORIGIN,
    },
)

CORS = {
    "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

_dynamodb      = None
_stats_table   = None
_comments_table = None


def _get_tables() -> tuple[Any, Any]:
    global _dynamodb, _stats_table, _comments_table
    # Lazy init so the module loads fast and tests can swap in fakes before
    # any real AWS calls happen.
    if _stats_table is None or _comments_table is None:
        if _dynamodb is None:
            logger.info("Connecting to DynamoDB")
            _dynamodb = boto3.resource("dynamodb")
        _stats_table    = _dynamodb.Table(STATS_TABLE)
        _comments_table = _dynamodb.Table(COMMENTS_TABLE)
    return _stats_table, _comments_table


def _set_tables_for_tests(stats_table: Any, comments_table: Any) -> None:
    global _stats_table, _comments_table
    _stats_table    = stats_table
    _comments_table = comments_table


def json_response(status_code: int, body: Any, extra_headers: dict[str, str] | None = None) -> dict[str, Any]:
    headers = {**CORS, "Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    return {"statusCode": status_code, "headers": headers, "body": json.dumps(body)}


def ok(body: Any, no_cache: bool = False) -> dict[str, Any]:
    extra = {"Cache-Control": "no-store"} if no_cache else None
    return json_response(200, body, extra_headers=extra)


def err(status_code: int, message: str) -> dict[str, Any]:
    return json_response(status_code, {"error": message})


def parse_body(event: dict[str, Any]) -> dict[str, Any]:
    body = event.get("body")
    if not body:
        return {}
    try:
        if event.get("isBase64Encoded"):
            body = base64.b64decode(body).decode("utf-8")
        if len(body.encode("utf-8")) > MAX_BODY_BYTES:
            raise ValueError("Request body too large")
        return json.loads(body)
    except json.JSONDecodeError as exc:
        # JSONDecodeError is a subclass of ValueError, so we have to catch it
        # before the bare `raise` below — otherwise the raw decoder message
        # leaks out instead of the consistent "Invalid JSON" clients expect.
        raise ValueError("Invalid JSON") from exc
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ValueError("Invalid JSON") from exc


_TAG_RE = re.compile(r"<[^>]*>")


def sanitize_text(value: Any, max_len: int = 1000) -> str:
    # Strip any HTML tags and hard-cap the length.
    # I don't want to render Markdown or HTML in comments — plain text only.
    return _TAG_RE.sub("", str(value)).strip()[:max_len]


def _format_date(iso_value: str) -> str:
    date = dt.datetime.fromisoformat(iso_value.replace("Z", "+00:00"))
    return f"{date.strftime('%b')} {date.day}, {date.year}"


def get_stats(post_id: str) -> dict[str, int]:
    stats_table, _ = _get_tables()
    item = stats_table.get_item(Key={"postId": post_id}).get("Item")
    # Fresh posts won't have a row yet — just return zeros rather than 404ing.
    if not item:
        return {"likes": 0, "reads": 0}
    return {
        "likes": int(item.get("likes", 0) or 0),
        "reads": int(item.get("reads", 0) or 0),
    }


def increment(post_id: str, field: str, delta: int = 1) -> int:
    stats_table, _ = _get_tables()
    # ADD creates the attribute if it doesn't exist, so I never have to PUT a
    # zero row first. One fewer round-trip per new post.
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
    return ok(rows, no_cache=True)


def handle_toggle_like(body: dict[str, Any]) -> dict[str, Any]:
    stats_table, _ = _get_tables()
    post_id = body.get("postId")
    liked   = body.get("liked")
    if not post_id:
        return err(400, "postId required")

    if liked:
        new_count = increment(post_id, "likes", 1)
    else:
        try:
            # Use a condition so we never go below zero, even if two unlike
            # requests race against each other.
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

    # ScanIndexForward=True means oldest first, which is what the UI expects.
    response = comments_table.query(
        KeyConditionExpression=Key("postId").eq(post_id),
        ScanIndexForward=True,
    )
    items = response.get("Items", [])
    comments = [
        {
            "id":        item["id"],
            "name":      item["name"],
            "text":      item["text"],
            "replyToId": item.get("replyToId"),
            "date":      _format_date(item["createdAt"]),
        }
        for item in items
    ]
    return ok(comments, no_cache=True)


def handle_add_comment(body: dict[str, Any]) -> dict[str, Any]:
    _, comments_table = _get_tables()
    post_id     = body.get("postId")
    name        = body.get("name")
    text        = body.get("text")
    reply_to_id = body.get("replyToId")

    if not post_id or not name or not text:
        return err(400, "postId, name and text required")

    safe_name        = sanitize_text(name, 80)
    safe_text        = sanitize_text(text, 1000)
    safe_reply_to_id = str(reply_to_id)[:200] if reply_to_id else None

    comment_id = str(uuid.uuid4())
    created_at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")

    # Prefixing the sort key with the timestamp keeps comments in time order
    # while the UUID suffix guarantees uniqueness even for concurrent writes.
    sort_key = f"{created_at}#{comment_id}"

    item: dict[str, Any] = {
        "postId":    post_id,
        "sk":        sort_key,
        "id":        comment_id,
        "name":      safe_name,
        "text":      safe_text,
        "createdAt": created_at,
    }
    if safe_reply_to_id:
        item["replyToId"] = safe_reply_to_id

    comments_table.put_item(Item=item)

    return ok({
        "id":        comment_id,
        "name":      safe_name,
        "text":      safe_text,
        "replyToId": safe_reply_to_id,
        "date":      _format_date(created_at),
    })


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    method    = ((event.get("requestContext") or {}).get("http") or {}).get("method")
    path      = event.get("rawPath", "/")
    route_key = f"{method} {path}"

    logger.info("Request", extra={"method": method, "path": path})

    if method == "OPTIONS":
        return {"statusCode": 204, "headers": CORS, "body": ""}

    # Check rate limits before doing anything else — no point parsing the body
    # if we're going to reject the request anyway.
    if method == "POST":
        ip = _get_ip(event)
        if not _check_rate_limit(ip, route_key):
            logger.warning("Rate limit hit", extra={"ip": ip, "route": route_key})
            return err(429, "Too many requests — please slow down")

    try:
        body = parse_body(event)
    except ValueError as exc:
        return err(400, str(exc))

    # GET handlers get the full event so they can read query params.
    # POST handlers only get the parsed body — they don't need the rest.
    routes: dict[tuple[str, str], Callable[[dict[str, Any]], dict[str, Any]]] = {
        ("GET",  "/stats"):    handle_get_stats,
        ("POST", "/like"):     handle_toggle_like,
        ("POST", "/read"):     handle_record_read,
        ("GET",  "/comments"): handle_get_comments,
        ("POST", "/comments"): handle_add_comment,
    }

    route = routes.get((method, path))
    if not route:
        return err(404, "Not found")

    try:
        return route(event if method == "GET" else body)
    except Exception as exc:
        logger.exception("Unhandled error while processing request: %s", exc, extra={"method": method, "path": path})
        return err(500, "Internal server error")
