"""Selecting an upstream by path prefix.

The compression design lists Claude Code and Codex together under
"point the base URL at the proxy". That is true but incomplete: the two
agents do not speak the same protocol. Claude Code speaks the Anthropic
Messages API; Codex speaks OpenAI's. A single-upstream proxy configured
per the design would send every Codex request to api.anthropic.com,
where it 404s — Codex would be wired and broken, which is worse than
Codex being unsupported.

So an upstream is selectable per request by a ``/__klio/upstream/<name>``
path prefix, stripped before forwarding. Claude Code keeps a bare
``http://localhost:8787``; Codex gets the prefixed URL.

This does not weaken the pass-through guarantee. Deciding where to
forward is the proxy's whole job; what these tests pin down is that
routing changes the destination and nothing else.
"""

from __future__ import annotations

import base64
import json

import httpx
import pytest

from klio_proxy.app import create_app
from klio_proxy.config import ProxyConfig

from .conftest import BackgroundServer, free_port
from .fake_upstream import create_fake_upstream


@pytest.fixture(scope="module")
def second_upstream() -> object:
    """A second fake, standing in for api.openai.com."""
    server = BackgroundServer(create_fake_upstream(), free_port())
    server.start()
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture(scope="module")
def dual_proxy(upstream: BackgroundServer, second_upstream: BackgroundServer) -> object:
    config = ProxyConfig(
        upstream_base_url=upstream.base_url,
        openai_base_url=second_upstream.base_url,
        port=free_port(),
    )
    server = BackgroundServer(create_app(config), config.port, transparent=True)
    server.start()
    try:
        yield server
    finally:
        server.stop()


def test_unprefixed_requests_go_to_the_default_upstream(
    client: httpx.Client, dual_proxy: BackgroundServer, upstream: BackgroundServer
) -> None:
    """Claude Code's plain base URL still reaches Anthropic.

    The routing feature must be invisible to the agent that does not use
    it — its configured base URL has no path at all.
    """
    response = client.post(f"{dual_proxy.base_url}/echo/v1/messages", content=b'{"a":1}')
    assert response.status_code == 200
    assert response.json()["raw_path"] == "/echo/v1/messages"
    # Reached the default fake, on the default fake's port.
    assert {k.lower(): v for k, v in response.json()["headers"]}["host"] == (
        f"127.0.0.1:{upstream.port}"
    )


def test_prefixed_requests_reach_the_named_upstream_with_prefix_stripped(
    client: httpx.Client, dual_proxy: BackgroundServer, second_upstream: BackgroundServer
) -> None:
    """Codex's URL routes to OpenAI, and the prefix never reaches it.

    A forwarded ``/__klio/upstream/openai/v1/responses`` would 404 at
    OpenAI just as surely as sending it to Anthropic would.
    """
    response = client.post(
        f"{dual_proxy.base_url}/__klio/upstream/openai/echo/v1/responses",
        content=b'{"model":"gpt-5"}',
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["raw_path"] == "/echo/v1/responses"
    assert "__klio" not in payload["raw_path"]
    assert {k.lower(): v for k, v in payload["headers"]}["host"] == (
        f"127.0.0.1:{second_upstream.port}"
    )


def test_routing_does_not_alter_the_body(
    client: httpx.Client, dual_proxy: BackgroundServer
) -> None:
    """Choosing a different destination changes only the destination."""
    body = json.dumps({"model": "gpt-5", "input": "hello ünïcode 🚀"}).encode("utf-8")
    response = client.post(
        f"{dual_proxy.base_url}/__klio/upstream/openai/echo/v1/responses", content=body
    )
    assert base64.b64decode(response.json()["body_b64"]) == body


def test_query_string_survives_the_prefix_strip(
    client: httpx.Client, dual_proxy: BackgroundServer
) -> None:
    response = client.get(
        f"{dual_proxy.base_url}/__klio/upstream/openai/echo/v1/models?limit=5&after=x"
    )
    assert response.json()["query_string"] == "limit=5&after=x"


def test_explicit_anthropic_prefix_works(
    client: httpx.Client, dual_proxy: BackgroundServer, upstream: BackgroundServer
) -> None:
    """The default upstream is also addressable by name, for symmetry."""
    response = client.get(f"{dual_proxy.base_url}/__klio/upstream/anthropic/echo/v1/models")
    assert response.json()["raw_path"] == "/echo/v1/models"
    assert {k.lower(): v for k, v in response.json()["headers"]}["host"] == (
        f"127.0.0.1:{upstream.port}"
    )


def test_unknown_upstream_is_named_not_silently_defaulted(
    client: httpx.Client, dual_proxy: BackgroundServer
) -> None:
    """A typo'd upstream fails loudly rather than going to Anthropic.

    Silently defaulting would send OpenAI-shaped requests to Anthropic
    and produce 404s that look like an Anthropic problem. Naming the
    misconfiguration is what makes it fixable.
    """
    response = client.post(
        f"{dual_proxy.base_url}/__klio/upstream/gemini/v1/anything", content=b"{}"
    )
    assert response.status_code == 404
    assert response.headers["x-klio-proxy-error"] == "unknown_upstream"
    message = response.json()["error"]["message"]
    assert "gemini" in message
    assert "anthropic" in message and "openai" in message
    assert "klio init" in message


def test_health_reports_every_upstream(
    client: httpx.Client, dual_proxy: BackgroundServer
) -> None:
    """`klio doctor` reads this to say where each agent's traffic goes."""
    payload = client.get(f"{dual_proxy.base_url}/__klio/health").json()
    assert set(payload["upstreams"]) == {"anthropic", "openai"}
