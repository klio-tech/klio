"""Streaming: chunks arrive as they are produced, not all at the end.

A buffering proxy and a streaming proxy return byte-identical bodies.
The only observable difference is *timing*, so timing is what these
tests measure. Without them, "streaming works" is an assumption that
holds until the first real session, where it shows up as a UI that sits
blank and then dumps a finished answer.
"""

from __future__ import annotations

import time

import httpx

from .conftest import BackgroundServer

#: The fake upstream sleeps this long between SSE events.
_EVENT_GAP = 0.08
_EVENT_COUNT = 6


def test_sse_chunks_arrive_incrementally(
    client: httpx.Client, proxy: BackgroundServer
) -> None:
    """First event lands long before the last one is produced.

    The upstream takes ``_EVENT_COUNT * _EVENT_GAP`` seconds to finish.
    A buffering proxy cannot deliver anything before then. Asserting the
    first chunk arrives in well under half that window separates the two
    implementations decisively, with enough slack to stay stable on a
    loaded CI box.
    """
    total_upstream_time = _EVENT_COUNT * _EVENT_GAP
    url = f"{proxy.base_url}/sse?count={_EVENT_COUNT}&delay={_EVENT_GAP}"

    started = time.monotonic()
    arrivals: list[float] = []
    chunks: list[bytes] = []

    with client.stream("GET", url) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        for chunk in response.iter_raw():
            if not chunk:
                continue
            arrivals.append(time.monotonic() - started)
            chunks.append(chunk)

    assert arrivals, "no chunks received at all"
    assert arrivals[0] < total_upstream_time / 2, (
        f"first chunk took {arrivals[0]:.3f}s of a {total_upstream_time:.3f}s stream — "
        "the proxy is buffering the response instead of streaming it"
    )
    # More than one distinct arrival proves the stream was delivered in
    # pieces rather than flushed once at close.
    assert len(arrivals) > 1, "entire stream arrived as a single chunk"
    assert arrivals[-1] - arrivals[0] > _EVENT_GAP, (
        "all chunks arrived at effectively the same instant — still buffered"
    )


def test_sse_content_is_complete_and_ordered(
    client: httpx.Client, proxy: BackgroundServer
) -> None:
    """Streaming does not come at the cost of dropping or reordering events."""
    url = f"{proxy.base_url}/sse?count=12&delay=0.01"

    with client.stream("GET", url) as response:
        body = b"".join(response.iter_raw())

    text = body.decode("utf-8")
    for i in range(12):
        assert f'"index":{i}' in text, f"event {i} missing from the stream"
    assert text.endswith("event: message_stop\ndata: {}\n\n")

    # Ordering: each index must appear after its predecessor.
    positions = [text.index(f'"index":{i}') for i in range(12)]
    assert positions == sorted(positions), "SSE events were reordered"


def test_streamed_response_matches_direct_byte_for_byte(
    client: httpx.Client, proxy: BackgroundServer, upstream: BackgroundServer
) -> None:
    """Same stream, one hop or two, identical bytes."""
    query = "?count=8&delay=0.01"

    with client.stream("GET", f"{upstream.base_url}/sse{query}") as response:
        direct = b"".join(response.iter_raw())
    with client.stream("GET", f"{proxy.base_url}/sse{query}") as response:
        through = b"".join(response.iter_raw())

    assert through == direct


def test_concurrent_streams_do_not_interleave(
    proxy: BackgroundServer,
) -> None:
    """Two simultaneous streams stay separate.

    Claude Code fans out to subagents, so concurrent streams through one
    proxy are the normal case rather than an edge case. Shared mutable
    state in the response path would show up here as one stream's bytes
    appearing in the other's.
    """
    import threading

    results: dict[int, bytes] = {}
    errors: list[BaseException] = []

    def pull(index: int) -> None:
        try:
            with httpx.Client(timeout=30.0) as c, c.stream(
                "GET", f"{proxy.base_url}/sse?count=10&delay=0.01"
            ) as response:
                results[index] = b"".join(response.iter_raw())
        except BaseException as exc:  # noqa: BLE001 - surfaced via `errors`
            errors.append(exc)

    threads = [threading.Thread(target=pull, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert not errors, f"concurrent streams raised: {errors}"
    assert len(results) == 4
    # Every stream is self-consistent and complete.
    for index, body in results.items():
        text = body.decode("utf-8")
        assert text.count("event: message_stop") == 1, f"stream {index} was corrupted"
        for i in range(10):
            assert f'"index":{i}' in text, f"stream {index} missing event {i}"
