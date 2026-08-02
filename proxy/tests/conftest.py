"""Test fixtures: real servers, real sockets, real streaming.

Deliberately *not* using ``httpx.ASGITransport`` to call the app
in-process. In-process ASGI skips the HTTP server entirely, and the HTTP
server is where the behaviours under test live: chunked framing, header
encoding, when a chunk is actually flushed to the socket. A passthrough
test that never touches a socket cannot tell a streaming proxy from a
buffering one.

So both the fake upstream and the proxy run as genuine uvicorn servers
on loopback ports, and the tests talk to them over TCP.
"""

from __future__ import annotations

import contextlib
import socket
import threading
import time
from collections.abc import Iterator

import httpx
import pytest
import uvicorn

from klio_proxy.app import create_app
from klio_proxy.config import ProxyConfig

from .fake_upstream import create_fake_upstream


def free_port() -> int:
    """Reserve an ephemeral port by binding and releasing it.

    Racy in principle — another process could claim the port between
    release and re-bind — but the window is microseconds on a loopback
    interface and the alternative (threading uvicorn's own socket back
    out of a background thread) buys robustness the test suite does not
    need.
    """
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class BackgroundServer:
    """A uvicorn server on its own thread, with start/stop that block."""

    def __init__(self, app: object, port: int, transparent: bool = False) -> None:
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            log_level="warning",
            access_log=False,
            # Without this, uvicorn installs signal handlers, which is
            # only legal on the main thread.
            lifespan="on",
            # Mirrors the production flags in klio_proxy.__main__: the
            # proxy forwards the upstream's own `server` and `date`, so
            # uvicorn must not add a second copy of each.
            server_header=not transparent,
            date_header=not transparent,
        )
        self._server = uvicorn.Server(config)
        self._server.install_signal_handlers = lambda: None  # type: ignore[method-assign]
        self._thread = threading.Thread(target=self._server.run, daemon=True)
        self.port = port
        self.base_url = f"http://127.0.0.1:{port}"

    def start(self, timeout: float = 15.0) -> None:
        self._thread.start()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._server.started:
                return
            time.sleep(0.01)
        raise RuntimeError(f"server on port {self.port} did not start within {timeout}s")

    def stop(self, timeout: float = 10.0) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=timeout)


@pytest.fixture(scope="session")
def upstream() -> Iterator[BackgroundServer]:
    """The fake Anthropic API."""
    server = BackgroundServer(create_fake_upstream(), free_port())
    server.start()
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture(scope="session")
def proxy(upstream: BackgroundServer) -> Iterator[BackgroundServer]:
    """The proxy under test, pointed at the fake upstream."""
    config = ProxyConfig(
        upstream_base_url=upstream.base_url,
        host="127.0.0.1",
        port=free_port(),
    )
    server = BackgroundServer(create_app(config), config.port, transparent=True)
    server.start()
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def client() -> Iterator[httpx.Client]:
    """A client that does as little as possible on the caller's behalf.

    ``follow_redirects=False`` and no automatic decoding: the tests
    compare raw wire bytes, so anything the client helpfully rewrites is
    a difference the tests would attribute to the proxy.
    """
    with httpx.Client(timeout=30.0, follow_redirects=False) as c:
        yield c
