"""Byte-exactness: a request through the proxy equals the same request direct.

Each test issues the *same* request twice — once straight at the fake
upstream, once through the proxy — and asserts the two are
indistinguishable. That construction is what makes the assertions
meaningful: they do not encode anyone's belief about what a correct
proxy emits, they compare against the ground truth of not having a proxy
at all.

Limitation, stated plainly: the upstream here is a local fake, not
``api.anthropic.com``. These tests prove the proxy does not alter what
passes through it. They cannot prove the real API accepts what we
forward — only a live run does that.
"""

from __future__ import annotations

import base64
import gzip
import json

import httpx

from klio_proxy.headers import HOP_BY_HOP_HEADERS

from .conftest import BackgroundServer
from .fake_upstream import UPSTREAM_MARKER

#: Headers excluded from direct-vs-proxied comparison, with cause.
#:
#: Hop-by-hop headers describe a single TCP connection and are
#: *supposed* to differ across two different connections; forwarding
#: them is the bug, not dropping them.
#:
#: ``date`` is a clock reading taken at two different moments.
#:
#: ``content-length`` on the echo endpoint reflects the echoed JSON,
#: which embeds the port number the request was addressed to — a
#: property of the test harness, not of the proxy. Body equality is
#: asserted separately and on the fields that matter.
_IGNORED_IN_COMPARISON = HOP_BY_HOP_HEADERS | {"date", "content-length"}


def comparable(headers: httpx.Headers) -> dict[str, str]:
    return {k.lower(): v for k, v in headers.items() if k.lower() not in _IGNORED_IN_COMPARISON}


def test_post_body_reaches_upstream_byte_for_byte(
    client: httpx.Client, proxy: BackgroundServer, upstream: BackgroundServer
) -> None:
    """The exact bytes the client sent are the exact bytes upstream received."""
    body = json.dumps(
        {
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": "hello é中文 🚀"}],
        }
    ).encode("utf-8")

    direct = client.post(f"{upstream.base_url}/echo/v1/messages", content=body)
    through = client.post(f"{proxy.base_url}/echo/v1/messages", content=body)

    assert direct.status_code == through.status_code == 200

    direct_body = base64.b64decode(direct.json()["body_b64"])
    through_body = base64.b64decode(through.json()["body_b64"])

    assert through_body == body, "proxy altered the request body"
    assert through_body == direct_body


def test_request_headers_reach_upstream_verbatim(
    client: httpx.Client, proxy: BackgroundServer, upstream: BackgroundServer
) -> None:
    """Every non-hop-by-hop request header survives the extra hop.

    Includes ``x-api-key`` and ``anthropic-beta``: an agent whose auth
    header the proxy dropped would see a 401 it has no way to explain,
    and a dropped beta header silently disables the feature the user
    turned on.
    """
    headers = {
        "x-api-key": "sk-ant-test-key",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "tool-search-2025-11-01,context-1m-2025-08-07",
        "content-type": "application/json",
        "x-custom-agent-header": "value-with-symbols !@#$%^&*()",
    }

    direct = client.post(f"{upstream.base_url}/echo/v1/messages", headers=headers, content=b"{}")
    through = client.post(f"{proxy.base_url}/echo/v1/messages", headers=headers, content=b"{}")

    received_direct = {k.lower(): v for k, v in direct.json()["headers"]}
    received_through = {k.lower(): v for k, v in through.json()["headers"]}

    for name, value in headers.items():
        assert received_through[name] == value, f"proxy altered request header {name}"

    # `host` must be rewritten to the upstream authority, not left as
    # localhost:<proxy port> — otherwise TLS SNI and Anthropic's own
    # routing both break in production.
    assert received_through["host"] == f"127.0.0.1:{upstream.port}"

    for name in received_direct:
        if name in HOP_BY_HOP_HEADERS:
            continue
        assert name in received_through, f"proxy dropped request header {name}"


def test_response_status_body_and_headers_are_verbatim(
    client: httpx.Client, proxy: BackgroundServer, upstream: BackgroundServer
) -> None:
    """A 429 arrives with its rate-limit headers and its error body intact.

    This is the case where a lossy proxy does real damage: an agent that
    cannot see ``retry-after`` retries immediately, and an agent that
    cannot see the error body cannot tell a throttle from an outage.
    """
    direct = client.get(f"{upstream.base_url}/status/429")
    through = client.get(f"{proxy.base_url}/status/429")

    assert through.status_code == 429
    assert through.status_code == direct.status_code
    assert through.content == direct.content
    assert comparable(through.headers) == comparable(direct.headers)

    assert through.headers["retry-after"] == "42"
    assert through.headers["anthropic-ratelimit-requests-remaining"] == "0"
    assert through.headers["request-id"] == "req_fake_12345"
    assert json.loads(through.content)["error"]["type"] == "rate_limit_error"


def test_server_error_bodies_pass_through(
    client: httpx.Client, proxy: BackgroundServer, upstream: BackgroundServer
) -> None:
    """5xx is forwarded as-is and never rewritten into a proxy error."""
    through = client.get(f"{proxy.base_url}/status/503")

    assert through.status_code == 503
    assert through.headers[UPSTREAM_MARKER] == "1", "response did not come from upstream"
    # The proxy only stamps this header on failures it originated. Its
    # absence here proves the 503 was forwarded, not manufactured.
    assert "x-klio-proxy-error" not in through.headers


def test_query_string_is_preserved_exactly(
    client: httpx.Client, proxy: BackgroundServer, upstream: BackgroundServer
) -> None:
    """Repeated keys, ordering, empty values and encoded characters survive."""
    query = "beta=true&limit=20&after_id=msg_01&after_id=msg_02&empty=&enc=a%2Bb%20c"

    direct = client.get(f"{upstream.base_url}/echo/v1/models?{query}")
    through = client.get(f"{proxy.base_url}/echo/v1/models?{query}")

    assert through.json()["query_string"] == query
    assert through.json()["query_string"] == direct.json()["query_string"]
    assert through.json()["raw_path"] == direct.json()["raw_path"]


def test_methods_other_than_post_are_forwarded(
    client: httpx.Client, proxy: BackgroundServer
) -> None:
    """DELETE and GET reach the upstream with method intact.

    Anthropic uses GET for ``/v1/models`` and DELETE for message batches.
    A proxy that only understands POST breaks them.
    """
    for method in ("GET", "DELETE", "PUT", "PATCH"):
        response = client.request(method, f"{proxy.base_url}/echo/v1/thing")
        assert response.status_code == 200
        assert response.json()["method"] == method


def test_compressed_response_is_not_silently_decoded(
    client: httpx.Client, proxy: BackgroundServer, upstream: BackgroundServer
) -> None:
    """A gzip body stays gzip, and its ``content-encoding`` stays truthful.

    The failure this guards against is subtle and total: httpx
    decompresses response bodies by default, so a proxy using
    ``aiter_bytes`` would hand the client plain JSON still labelled
    ``content-encoding: gzip``. The client then tries to gunzip valid
    JSON and every request fails.
    """
    # `httpx.Client` decodes on the way in, so read the raw wire bytes
    # to see what the proxy actually put on the socket.
    with client.stream("GET", f"{proxy.base_url}/gzipped") as response:
        raw = b"".join(response.iter_raw())
        headers = response.headers

    assert headers["content-encoding"] == "gzip"
    # Decodes cleanly => the bytes really were gzip, not double-encoded
    # and not decoded-but-mislabelled.
    payload = json.loads(gzip.decompress(raw))
    assert payload["content"].startswith("compressible ")

    direct = client.get(f"{upstream.base_url}/gzipped")
    through = client.get(f"{proxy.base_url}/gzipped")
    assert through.json() == direct.json()


def test_repeated_response_headers_are_not_collapsed(
    client: httpx.Client, proxy: BackgroundServer, upstream: BackgroundServer
) -> None:
    """Two ``set-cookie`` headers arrive as two, not one.

    Passing upstream headers through a dict — the obvious implementation
    — silently keeps only the last of any repeated header.
    """
    direct = client.get(f"{upstream.base_url}/repeated-headers")
    through = client.get(f"{proxy.base_url}/repeated-headers")

    direct_cookies = direct.headers.get_list("set-cookie")
    through_cookies = through.headers.get_list("set-cookie")

    assert len(direct_cookies) == 2, "fixture no longer emits two set-cookie headers"
    assert through_cookies == direct_cookies


def test_empty_body_post_is_forwarded(client: httpx.Client, proxy: BackgroundServer) -> None:
    """A zero-length body stays zero-length rather than becoming absent."""
    response = client.post(f"{proxy.base_url}/echo/v1/messages", content=b"")
    assert base64.b64decode(response.json()["body_b64"]) == b""


def test_large_body_is_forwarded_intact(client: httpx.Client, proxy: BackgroundServer) -> None:
    """A multi-megabyte body survives — agents send whole files.

    Also a guard against a future compressor being wired in without
    length bookkeeping: a mismatched ``content-length`` truncates the
    body, and truncation of a large request is exactly the kind of bug
    that only shows up on a real workload.
    """
    body = json.dumps({"messages": [{"role": "user", "content": "x" * 4_000_000}]}).encode()
    response = client.post(f"{proxy.base_url}/echo/v1/messages", content=body)
    assert base64.b64decode(response.json()["body_b64"]) == body


def test_health_endpoint_is_not_forwarded(client: httpx.Client, proxy: BackgroundServer) -> None:
    """The control endpoint is served locally and never reaches upstream."""
    response = client.get(f"{proxy.base_url}/__klio/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["mode"] == "passthrough"
    assert UPSTREAM_MARKER not in response.headers
