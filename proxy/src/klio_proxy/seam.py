"""The seam a compressor plugs into — identity in stage 3.

Stage 3 of the Klio Compression design ships the proxy as a pure
pass-through. This module is the single place where that changes: the
router and compressors from stage 4 replace the body of
:func:`transform_request_body` and nothing else in the proxy moves.

Two properties are enforced here rather than at the call site, so they
cannot be forgotten when the real compressor lands:

**Fail-open.** :func:`apply_request_seam` catches every exception a
transform can raise and returns the original bytes. Compression failing
costs tokens; a compressor bug must never cost a working session. There
is no configuration flag to turn this off, because there is no situation
in which "break the user's session" is the better outcome.

**Never touch what we do not understand.** The transform receives the
content type and only acts on bodies it recognises. A ``tool_reference``
block, a ``multipart/form-data`` upload, or a shape Anthropic ships next
month passes through because the default branch is "return input".

``tool_reference`` in particular is load bearing. Pointing
``ANTHROPIC_BASE_URL`` at a non-Anthropic host disables MCP Tool Search;
``klio init`` re-enables it with ``ENABLE_TOOL_SEARCH=true``, which only
works if these blocks reach the API intact. Mangling them would cost
~85% on tool schemas while we claim to save tokens — a net loss the user
cannot see. Stage 3 gets this right the only way that is certain: by not
parsing the body at all.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def transform_request_body(body: bytes, content_type: str | None) -> bytes:
    """Compress an outbound request body. Identity in stage 3.

    :param body: the exact bytes the client sent.
    :param content_type: the client's ``Content-Type``, or ``None``.
    :returns: bytes to forward upstream.

    Stage 4 replaces the body of this function with a call into the
    compressor router. The signature is the contract: bytes in, bytes
    out, no I/O, no network, no shared state. A transform that needs to
    reach the network to do its job does not belong in the request path.

    Implementations MUST remain safe to call with arbitrary bytes,
    including empty ones and content types they have never seen. Raising
    is survivable — :func:`apply_request_seam` catches it — but a
    transform that routinely raises is a transform that routinely
    forfeits its own savings.
    """
    del content_type  # unused until stage 4 routes by content type
    return body


def apply_request_seam(body: bytes, content_type: str | None) -> bytes:
    """Run the request transform, falling back to the original on any error.

    This is the only function the request path calls. It exists so that
    fail-open is a property of the architecture rather than of whoever
    writes the next compressor.

    ``BaseException`` is deliberately not caught: ``KeyboardInterrupt``
    and ``SystemExit`` mean the process is going away and swallowing
    them would make the proxy unkillable. Everything a transform can
    plausibly raise — ``ValueError`` on malformed input,
    ``MemoryError``, ``RecursionError``, an ``ImportError`` from a model
    that failed to load — derives from ``Exception`` and is caught.
    """
    try:
        transformed = transform_request_body(body, content_type)
    except Exception:
        logger.warning(
            "klio-proxy: request transform failed, forwarding original body unchanged "
            "(%d bytes)",
            len(body),
            exc_info=True,
        )
        return body

    if not isinstance(transformed, bytes):
        # A transform that returns the wrong type would otherwise blow up
        # deeper in httpx, where the traceback no longer names the
        # culprit. Fail open here, loudly.
        logger.warning(
            "klio-proxy: request transform returned %s, not bytes; "
            "forwarding original body unchanged",
            type(transformed).__name__,
        )
        return body

    return transformed
