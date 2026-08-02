"""The proxy application: a transparent forwarder for the Anthropic API.

Request path, end to end::

    Claude Code ──▶ [ this app ] ──▶ https://api.anthropic.com
                         │
                         └─ seam.apply_request_seam()  (identity in stage 3)

Three properties drive every decision in this file.

**Responses stream.** Claude Code streams. Buffering an SSE response and
replaying it once complete still produces the right final answer, which
is exactly what makes it dangerous: a smoke test passes and the user
watches a blank screen for ninety seconds. The response leg is a
generator over ``aiter_raw()`` from first byte to last, with no
accumulation anywhere.

**Bodies and headers are verbatim.** The response body is forwarded as
raw bytes — still compressed if the upstream compressed it — and headers
pass through minus hop-by-hop (see :mod:`klio_proxy.headers`). Status
codes, 4xx/5xx error bodies and ``anthropic-ratelimit-*`` headers reach
the client unaltered, because an agent that cannot see it is being rate
limited will retry into a wall.

**Failure is fast and named.** The proxy cannot fail open when the
upstream is unreachable — there is nowhere else to send the request. So
it fails *fast and legibly* instead: a 502 in Anthropic's own error
envelope, an ``x-klio-proxy-error`` header naming the class of failure,
and a log line. Never a hang. A hang is the one failure mode with no
diagnosis and no recovery.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from .config import ProxyConfig, load_config
from .headers import (
    ensure_no_transparent_decoding,
    forwardable_request_headers,
    forwardable_response_headers,
)
from .seam import apply_request_seam

logger = logging.getLogger("klio_proxy")

#: Methods forwarded by the catch-all route. Anthropic's API only uses
#: GET/POST/DELETE today, but a proxy that 405s on a method the API
#: gains next month is a proxy that breaks a working session for no
#: reason.
_FORWARDED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

#: Prefix for the proxy's own endpoints. Namespaced under ``__klio`` so
#: it can never collide with an Anthropic API path — every real path
#: begins ``/v1/``.
_CONTROL_PREFIX = "/__klio"


def build_client(config: ProxyConfig) -> httpx.AsyncClient:
    """Construct the upstream HTTP client.

    ``follow_redirects=False`` is intentional. A redirect the proxy
    follows silently is a redirect the client never learns about; if
    Anthropic starts issuing them, the client should see the 3xx and
    decide, exactly as it would talking to the API directly.
    """
    timeout = httpx.Timeout(
        connect=config.connect_timeout,
        read=config.read_timeout,
        # Writes and pool acquisition inherit "no limit" for the same
        # reason reads do: a large request body on a slow uplink, or a
        # burst of concurrent subagent calls, must not be cut off by a
        # clock the user cannot see.
        write=None,
        pool=None,
    )
    return httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=False,
        # Generous pool: Claude Code fans out to subagents, and a pool
        # that blocks is indistinguishable from a proxy that is hung.
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
    )


def create_app(config: ProxyConfig | None = None) -> FastAPI:
    """Build the ASGI application.

    ``config`` is injectable so tests can point the proxy at a local
    fake upstream without touching the process environment.
    """
    resolved = config if config is not None else load_config()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # One client for the process lifetime — connection reuse is the
        # difference between adding ~1ms and adding a full TLS handshake
        # to every model call.
        client = build_client(resolved)
        app.state.client = client
        app.state.config = resolved
        logger.info(
            "klio-proxy ready on %s:%d forwarding to %s",
            resolved.host,
            resolved.port,
            resolved.upstream_origin,
        )
        try:
            yield
        finally:
            await client.aclose()

    app = FastAPI(
        title="Klio compression proxy",
        version="0.0.1",
        lifespan=lifespan,
        # The proxy is not a documented API surface, and leaving the
        # docs routes mounted would make /docs and /openapi.json
        # unforwardable to the upstream.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.get(f"{_CONTROL_PREFIX}/health")
    async def health() -> dict[str, Any]:
        """Liveness only — deliberately does not touch the upstream.

        Docker's healthcheck and the platform supervisor poll this. If
        it reported upstream reachability, an Anthropic outage or a
        flaky wifi connection would make the supervisor kill and restart
        a perfectly healthy proxy, turning a transient upstream problem
        into a local restart loop.

        ``klio doctor`` is where end-to-end reachability is checked, on
        demand, by a human who can act on the answer.
        """
        return {
            "status": "ok",
            "upstream": resolved.upstream_origin,
            # Stage 3 ships pass-through only. Surfacing it here means
            # `klio doctor` can state plainly what the proxy is doing
            # rather than implying savings that do not exist yet.
            "mode": "passthrough",
        }

    @app.api_route("/{full_path:path}", methods=_FORWARDED_METHODS)
    async def forward(request: Request) -> Response:
        return await _forward(request, app.state.client, resolved)

    return app


async def _forward(
    request: Request,
    client: httpx.AsyncClient,
    config: ProxyConfig,
) -> Response:
    """Forward one request upstream and stream the response back."""
    url = _upstream_url(request, config)

    # The request body is read in full rather than streamed. Two
    # reasons: the compression seam needs the whole body to reason about
    # it, and Anthropic Messages requests are a single JSON document
    # that the client sends in one shot anyway — there is no client-side
    # streaming to preserve. The RESPONSE is what streams, and that is
    # handled below.
    body = await request.body()
    forwarded_body = apply_request_seam(body, request.headers.get("content-type"))

    headers = ensure_no_transparent_decoding(
        forwardable_request_headers(request.headers.items())
    )

    upstream_request = client.build_request(
        method=request.method,
        url=url,
        headers=headers,
        content=forwarded_body,
    )

    try:
        upstream_response = await client.send(upstream_request, stream=True)
    except httpx.ConnectError as exc:
        return _proxy_error(
            "upstream_unreachable",
            f"klio-proxy could not reach {config.upstream_origin}: {exc}. "
            f"Check your network, then run `klio doctor`.",
            exc,
        )
    except httpx.ConnectTimeout as exc:
        return _proxy_error(
            "upstream_connect_timeout",
            f"klio-proxy timed out connecting to {config.upstream_origin} after "
            f"{config.connect_timeout}s. Check your network, then run `klio doctor`.",
            exc,
        )
    except httpx.TimeoutException as exc:
        return _proxy_error(
            "upstream_timeout",
            f"klio-proxy timed out talking to {config.upstream_origin}: {exc}",
            exc,
        )
    except httpx.HTTPError as exc:
        return _proxy_error(
            "upstream_transport_error",
            f"klio-proxy failed talking to {config.upstream_origin}: "
            f"{type(exc).__name__}: {exc}",
            exc,
        )

    # Headers are assigned via `_with_raw_headers` rather than passed to
    # the constructor: Starlette's `headers=` argument takes a Mapping,
    # which silently collapses repeated headers. `set-cookie` and
    # `www-authenticate` legitimately repeat, and "verbatim" has to mean
    # verbatim.
    #
    # `background=` closes the upstream response after the last byte
    # reaches the client. Without it, every request leaks a connection
    # from the pool and the proxy degrades into a hang after ~100 calls.
    response = StreamingResponse(
        _stream_upstream(upstream_response),
        status_code=upstream_response.status_code,
        background=BackgroundTask(upstream_response.aclose),
    )
    return _with_raw_headers(
        response,
        forwardable_response_headers(upstream_response.headers.multi_items()),
    )


def _with_raw_headers(
    response: StreamingResponse,
    headers: list[tuple[str, str]],
) -> StreamingResponse:
    """Replace a response's headers wholesale, preserving duplicates.

    Starlette encodes header names and values as latin-1. Anything the
    upstream sent already survived that round trip on the way in, so a
    value that fails to encode here means it was fabricated locally —
    worth failing loudly rather than corrupting.
    """
    response.raw_headers = [
        (name.lower().encode("latin-1"), value.encode("latin-1")) for name, value in headers
    ]
    return response


async def _stream_upstream(response: httpx.Response) -> AsyncIterator[bytes]:
    """Yield upstream bytes as they arrive.

    ``aiter_raw`` rather than ``aiter_bytes``: raw skips httpx's
    transparent content decoding, so a gzipped or brotli'd upstream body
    reaches the client still encoded and still matching the
    ``Content-Encoding`` header we forwarded alongside it.

    For SSE this loop is the whole streaming guarantee — each chunk is
    handed to the ASGI server the moment it arrives, with nothing
    accumulated between iterations.
    """
    try:
        async for chunk in response.aiter_raw():
            yield chunk
    except httpx.HTTPError as exc:
        # The upstream connection broke partway through a response whose
        # status line and headers the client already received. There is
        # no way to signal an error at this point in HTTP/1.1 other than
        # ending the body early, which is what returning does — the
        # client sees a truncated stream, the same as if it had been
        # talking to Anthropic directly when the connection dropped.
        # Logging is the only place the real cause can be recorded.
        logger.warning(
            "klio-proxy: upstream stream ended early: %s: %s",
            type(exc).__name__,
            exc,
        )
        return


def _upstream_url(request: Request, config: ProxyConfig) -> str:
    """Rebuild the target URL against the upstream origin.

    The raw, still-percent-encoded path from the ASGI scope is preferred
    over the decoded ``request.url.path`` so an encoded character in a
    path segment is not silently normalised into a different path. The
    query string is taken raw for the same reason: re-encoding it
    through a parser would reorder repeated keys and rewrite ``+``.
    """
    raw_path: bytes = request.scope.get("raw_path") or request.scope["path"].encode("utf-8")
    query: bytes = request.scope.get("query_string", b"")

    target = config.upstream_origin + raw_path.decode("utf-8")
    if query:
        target += "?" + query.decode("utf-8")
    return target


def _proxy_error(kind: str, message: str, exc: BaseException) -> JSONResponse:
    """Render a proxy-originated failure the client can act on.

    Shaped as Anthropic's error envelope so a client that parses error
    bodies gets a structure it understands rather than an exception
    while handling an exception. The ``x-klio-proxy-error`` header is
    the honest part: it says plainly that this response came from the
    proxy and not from the API.

    This is the one place the proxy is *not* transparent, and it should
    not be. When the proxy is the problem, saying so is the whole job —
    otherwise the user spends the afternoon convinced Anthropic is down.
    """
    logger.error("klio-proxy: %s: %s", kind, exc)
    return JSONResponse(
        status_code=502,
        content={
            "type": "error",
            "error": {"type": "api_error", "message": message},
        },
        headers={"x-klio-proxy-error": kind},
    )
