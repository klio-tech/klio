"""A local stand-in for ``https://api.anthropic.com``.

Why a fake rather than the live API: the passthrough tests assert
*byte-exact* equality between a request made directly and the same
request made through the proxy. Against the live API that comparison is
impossible — two calls differ in ``request-id``, in
``anthropic-ratelimit-*`` counters, in timing, and in the model's own
non-deterministic output. Against a fake that echoes its input, any
difference between the two responses is the proxy's fault and only the
proxy's fault, which is exactly the property the tests need.

The fake is not a mock of Anthropic's semantics. It is a mirror: it
reports what it received (method, path, query, headers, body) so the
tests can verify what actually crossed the wire, and it can emit SSE,
arbitrary status codes, repeated headers and compressed bodies on
demand.

What this does NOT prove is that the real API accepts what we forward.
That gap is closed by a live end-to-end run, not by this file.
"""

from __future__ import annotations

import asyncio
import base64
import gzip
import json
from collections.abc import AsyncIterator

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

#: Marker header the fake always sets, so a test can tell a response
#: that reached the fake from one the proxy manufactured itself.
UPSTREAM_MARKER = "x-fake-upstream"


def create_fake_upstream() -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.api_route(
        "/echo/{rest:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def echo(request: Request) -> JSONResponse:
        """Mirror the received request back as JSON.

        The body is base64-encoded rather than decoded as text: the
        tests need to compare exact bytes, and round-tripping through a
        text codec would hide precisely the corruption they are looking
        for.
        """
        body = await request.body()
        return JSONResponse(
            {
                "method": request.method,
                "raw_path": request.scope.get("raw_path", b"").decode("utf-8"),
                "query_string": request.scope.get("query_string", b"").decode("utf-8"),
                # multi_items preserves duplicates and order.
                "headers": list(request.headers.items()),
                "body_b64": base64.b64encode(body).decode("ascii"),
            },
            headers={UPSTREAM_MARKER: "1"},
        )

    @app.get("/status/{code}")
    async def status_code(code: int) -> Response:
        """Return an arbitrary status with a body and rate-limit headers.

        Models the case that matters most for transparency: a 429 whose
        ``anthropic-ratelimit-*`` and ``retry-after`` headers the client
        needs in order to back off correctly. A proxy that drops them
        turns a recoverable throttle into a retry storm.
        """
        return Response(
            content=json.dumps(
                {"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}}
            ).encode("utf-8"),
            status_code=code,
            media_type="application/json",
            headers={
                UPSTREAM_MARKER: "1",
                "retry-after": "42",
                "anthropic-ratelimit-requests-remaining": "0",
                "anthropic-ratelimit-requests-reset": "2026-08-01T20:00:00Z",
                "request-id": "req_fake_12345",
            },
        )

    @app.get("/sse")
    async def sse(request: Request) -> StreamingResponse:
        """Emit SSE events slowly, with a gap between each.

        The gaps are the point. A proxy that buffers the whole stream
        produces byte-identical output to one that streams it — the only
        observable difference is *when* each chunk arrives. The
        streaming test measures arrival times against these gaps.
        """
        count = int(request.query_params.get("count", "5"))
        delay = float(request.query_params.get("delay", "0.08"))

        async def gen() -> AsyncIterator[bytes]:
            for i in range(count):
                event = (
                    f"event: content_block_delta\n"
                    f'data: {{"index":{i},"delta":{{"text":"chunk-{i}"}}}}\n\n'
                )
                yield event.encode("utf-8")
                await asyncio.sleep(delay)
            yield b"event: message_stop\ndata: {}\n\n"

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={UPSTREAM_MARKER: "1", "cache-control": "no-cache"},
        )

    @app.get("/sse-forever")
    async def sse_forever() -> StreamingResponse:
        """An SSE stream that never ends.

        Used by the kill-mid-flight test: the client must be reading a
        live response at the moment the proxy dies, which requires a
        stream that will not finish on its own first.
        """

        async def gen() -> AsyncIterator[bytes]:
            i = 0
            while True:
                yield f"event: ping\ndata: {{\"n\":{i}}}\n\n".encode()
                await asyncio.sleep(0.05)
                i += 1

        return StreamingResponse(gen(), media_type="text/event-stream")

    @app.get("/gzipped")
    async def gzipped() -> Response:
        """A gzip-encoded body, declared as such.

        Catches the classic transparent-proxy bug: an HTTP client that
        decompresses on the way in, paired with a proxy that forwards
        the original ``Content-Encoding``, hands the client plain bytes
        labelled gzip. The client then fails to decode a body that is
        already decoded.
        """
        payload = json.dumps({"content": "compressible " * 200}).encode("utf-8")
        return Response(
            content=gzip.compress(payload),
            media_type="application/json",
            headers={
                UPSTREAM_MARKER: "1",
                "content-encoding": "gzip",
            },
        )

    @app.get("/repeated-headers")
    async def repeated_headers() -> Response:
        """Two ``set-cookie`` headers — the duplicate-collapse canary."""
        raw = Response(content=b"{}", media_type="application/json")
        raw.raw_headers = [
            (b"content-type", b"application/json"),
            (b"content-length", b"2"),
            (b"set-cookie", b"first=1; Path=/"),
            (b"set-cookie", b"second=2; Path=/"),
            (UPSTREAM_MARKER.encode(), b"1"),
        ]
        return raw

    @app.get("/slow-headers")
    async def slow_headers() -> StreamingResponse:
        """Delays the first byte, so a test can catch the proxy mid-flight."""

        async def gen() -> AsyncIterator[bytes]:
            await asyncio.sleep(5.0)
            yield b"too late"

        return StreamingResponse(gen(), media_type="text/plain")

    return app
