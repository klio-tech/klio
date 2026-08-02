"""``tool_reference`` blocks must survive the proxy untouched.

Why this has its own file rather than being one more passthrough case:
it is the one place where being wrong is *invisible and expensive*.

Pointing ``ANTHROPIC_BASE_URL`` at a non-Anthropic host disables MCP
Tool Search by default. ``klio init`` re-enables it with
``ENABLE_TOOL_SEARCH=true``, which only works if the proxy forwards
``tool_reference`` blocks correctly. Get it wrong and the user loses
~85% on tool schemas — silently, while Klio's own messaging claims to be
saving them tokens. A net loss nobody can see is worse than no product.

Stage 3 forwards the body without parsing it, so correctness here is
structural rather than earned. These tests exist to make sure it stays
that way: when the stage-4 compressor starts parsing bodies, this file
is what fails if it touches a block it should not.
"""

from __future__ import annotations

import base64
import json

import httpx

from .conftest import BackgroundServer

#: A request shaped the way Claude Code sends one with Tool Search on:
#: deferred tool definitions, the search tool itself, and prior
#: ``tool_reference`` / ``tool_search_result`` blocks replayed in the
#: message history.
TOOL_SEARCH_REQUEST: dict = {
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 4096,
    "tools": [
        {"type": "tool_search_tool_20251119", "name": "tool_search"},
        {
            "name": "github__create_issue",
            "description": "Create a GitHub issue",
            "defer_loading": True,
            "input_schema": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string"},
                    "title": {"type": "string"},
                    "body": {"type": "string"},
                },
                "required": ["repo", "title"],
            },
        },
        {
            "name": "slack__post_message",
            "description": "Post a message to Slack",
            "defer_loading": True,
            "input_schema": {
                "type": "object",
                "properties": {"channel": {"type": "string"}, "text": {"type": "string"}},
                "required": ["channel", "text"],
            },
        },
    ],
    "messages": [
        {"role": "user", "content": "File an issue about the flaky test"},
        {
            "role": "assistant",
            "content": [
                {
                    "type": "server_tool_use",
                    "id": "srvtoolu_01ABC",
                    "name": "tool_search",
                    "input": {"query": "create github issue"},
                },
                {
                    "type": "tool_search_result",
                    "tool_use_id": "srvtoolu_01ABC",
                    "content": [
                        {"type": "tool_reference", "name": "github__create_issue"},
                        {"type": "tool_reference", "name": "slack__post_message"},
                    ],
                },
            ],
        },
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_01XYZ",
                    "name": "github__create_issue",
                    "input": {"repo": "klio-tech/klio", "title": "Flaky test"},
                }
            ],
        },
    ],
}


def test_tool_reference_request_reaches_upstream_byte_for_byte(
    client: httpx.Client, proxy: BackgroundServer
) -> None:
    """The serialised request arrives upstream identical, byte for byte.

    Byte equality rather than structural equality on purpose: JSON that
    re-serialises to different bytes (reordered keys, changed spacing,
    escaped non-ASCII) still parses the same but breaks prompt caching,
    which is measured on the exact prefix bytes. A proxy that "only"
    reformats JSON quietly destroys the user's cache hits.
    """
    body = json.dumps(TOOL_SEARCH_REQUEST).encode("utf-8")

    response = client.post(
        f"{proxy.base_url}/echo/v1/messages",
        content=body,
        headers={
            "content-type": "application/json",
            "anthropic-beta": "tool-search-2025-11-01",
        },
    )

    received = base64.b64decode(response.json()["body_b64"])
    assert received == body, "proxy altered a request carrying tool_reference blocks"


def test_tool_reference_blocks_survive_structurally(
    client: httpx.Client, proxy: BackgroundServer
) -> None:
    """Both ``tool_reference`` blocks arrive, named and typed correctly."""
    body = json.dumps(TOOL_SEARCH_REQUEST).encode("utf-8")
    response = client.post(f"{proxy.base_url}/echo/v1/messages", content=body)

    received = json.loads(base64.b64decode(response.json()["body_b64"]))
    search_result = received["messages"][1]["content"][1]

    assert search_result["type"] == "tool_search_result"
    references = [b for b in search_result["content"] if b["type"] == "tool_reference"]
    assert [r["name"] for r in references] == [
        "github__create_issue",
        "slack__post_message",
    ]


def test_deferred_tool_definitions_are_not_stripped(
    client: httpx.Client, proxy: BackgroundServer
) -> None:
    """``defer_loading`` and the search tool itself survive.

    These are what make Tool Search work at all. A proxy that dropped
    ``defer_loading`` would send every schema in full on every turn —
    the exact ~85% regression this feature exists to prevent.
    """
    body = json.dumps(TOOL_SEARCH_REQUEST).encode("utf-8")
    response = client.post(f"{proxy.base_url}/echo/v1/messages", content=body)

    received = json.loads(base64.b64decode(response.json()["body_b64"]))
    tools = {t.get("name"): t for t in received["tools"]}

    assert tools["tool_search"]["type"] == "tool_search_tool_20251119"
    assert tools["github__create_issue"]["defer_loading"] is True
    assert tools["slack__post_message"]["defer_loading"] is True
    assert tools["github__create_issue"]["input_schema"]["required"] == ["repo", "title"]


def test_anthropic_beta_header_for_tool_search_is_forwarded(
    client: httpx.Client, proxy: BackgroundServer
) -> None:
    """The beta opt-in header reaches the API.

    Without it the API ignores the deferred definitions and Tool Search
    is off — the same net loss as mangling the blocks, arrived at from a
    different direction.
    """
    response = client.post(
        f"{proxy.base_url}/echo/v1/messages",
        content=b"{}",
        headers={"anthropic-beta": "tool-search-2025-11-01,context-1m-2025-08-07"},
    )
    received = {k.lower(): v for k, v in response.json()["headers"]}
    assert received["anthropic-beta"] == "tool-search-2025-11-01,context-1m-2025-08-07"
