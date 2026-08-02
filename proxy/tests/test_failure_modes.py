"""What happens when things break — and how fast the user finds out.

Once ``ANTHROPIC_BASE_URL`` points at localhost, the proxy is a single
point of failure for the agent's ability to reach a model at all. The
design's stated mitigation is fail-open plus a supervised service, but
neither helps with the failure mode that actually ruins an afternoon: a
proxy that neither works nor errors, and just hangs. Every test here
asserts a bound on how long a failure takes to surface.
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
from collections.abc import Iterator

import httpx
import pytest

from klio_proxy import seam
from klio_proxy.config import ProxyConfig

from .conftest import BackgroundServer, free_port


def test_upstream_unreachable_returns_a_named_error_fast() -> None:
    """A dead upstream produces a 502 that says so, quickly.

    The proxy cannot fail open here — there is no second place to send
    the request. So it must fail *legibly*: a status the client
    understands, a header naming the failure class, and a message that
    points at the next step.
    """
    # A port with nothing on it. Reserving and releasing guarantees it is
    # unused rather than merely unlikely to be used.
    dead_port = free_port()
    config = ProxyConfig(
        upstream_base_url=f"http://127.0.0.1:{dead_port}",
        port=free_port(),
        connect_timeout=2.0,
    )
    from klio_proxy.app import create_app

    server = BackgroundServer(create_app(config), config.port, transparent=True)
    server.start()
    try:
        started = time.monotonic()
        with httpx.Client(timeout=15.0) as client:
            response = client.post(f"{server.base_url}/v1/messages", content=b"{}")
        elapsed = time.monotonic() - started

        assert response.status_code == 502
        assert response.headers["x-klio-proxy-error"] == "upstream_unreachable"

        payload = response.json()
        assert payload["type"] == "error"
        assert "klio-proxy" in payload["error"]["message"]
        assert "klio doctor" in payload["error"]["message"]

        assert elapsed < 10.0, f"took {elapsed:.1f}s to report an unreachable upstream"
    finally:
        server.stop()


def test_seam_exception_fails_open(
    client: httpx.Client, proxy: BackgroundServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A transform that raises must not cost the request.

    This is the fail-open guarantee from the design, tested at the level
    it matters: not "the function returns the original bytes" but "the
    agent's request still reaches the model".
    """
    body = b'{"model":"claude-sonnet-4-20250514","messages":[]}'

    def exploding(_body: bytes, _content_type: str | None) -> bytes:
        raise RuntimeError("compressor model failed to load")

    monkeypatch.setattr(seam, "transform_request_body", exploding)

    response = client.post(f"{proxy.base_url}/echo/v1/messages", content=body)

    assert response.status_code == 200
    import base64

    assert base64.b64decode(response.json()["body_b64"]) == body


def test_seam_returning_wrong_type_fails_open(
    client: httpx.Client, proxy: BackgroundServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A transform that returns a str rather than bytes is caught here.

    Left uncaught it would fail deep inside httpx, where the traceback
    no longer names the transform that caused it.
    """
    body = b'{"messages":[]}'
    monkeypatch.setattr(seam, "transform_request_body", lambda b, c: "not bytes")

    response = client.post(f"{proxy.base_url}/echo/v1/messages", content=body)

    assert response.status_code == 200
    import base64

    assert base64.b64decode(response.json()["body_b64"]) == body


def test_seam_memory_error_fails_open(
    client: httpx.Client, proxy: BackgroundServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    """OOM inside the compressor is survivable, per the design's list."""
    body = b'{"messages":[]}'

    def oom(_body: bytes, _content_type: str | None) -> bytes:
        raise MemoryError("out of memory loading klio-compress-v1")

    monkeypatch.setattr(seam, "transform_request_body", oom)
    response = client.post(f"{proxy.base_url}/echo/v1/messages", content=body)
    assert response.status_code == 200


@pytest.fixture
def proxy_subprocess(upstream: BackgroundServer) -> Iterator[tuple[subprocess.Popen, str]]:
    """The proxy as a real OS process, so it can be really killed.

    The thread-based fixtures elsewhere cannot be SIGKILLed independently
    of the test runner. Proving the mid-flight-death behaviour needs a
    process the test can actually terminate.
    """
    port = free_port()
    env = {
        **os.environ,
        "KLIO_PROXY_UPSTREAM_URL": upstream.base_url,
        "KLIO_PROXY_PORT": str(port),
        "KLIO_PROXY_HOST": "127.0.0.1",
        "PYTHONPATH": os.pathsep.join(
            [os.path.join(os.path.dirname(os.path.dirname(__file__)), "src")]
            + ([os.environ["PYTHONPATH"]] if os.environ.get("PYTHONPATH") else [])
        ),
    }
    process = subprocess.Popen(
        [sys.executable, "-m", "klio_proxy"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    base_url = f"http://127.0.0.1:{port}"

    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            _, err = process.communicate()
            raise RuntimeError(f"proxy exited during startup: {err.decode(errors='replace')}")
        with socket.socket() as probe:
            probe.settimeout(0.25)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                break
        time.sleep(0.05)
    else:
        process.kill()
        raise RuntimeError("proxy subprocess never started listening")

    try:
        yield process, base_url
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=10)


def test_killing_the_proxy_mid_stream_fails_cleanly_not_slowly(
    proxy_subprocess: tuple[subprocess.Popen, str],
) -> None:
    """SIGKILL during an in-flight stream surfaces as an error, promptly.

    The bad outcome is not the error — a killed proxy has to break the
    request. The bad outcome is the client sitting on a socket that will
    never produce another byte and never close, which is what happens
    when a proxy holds the connection open on a coroutine that has gone
    away. Here the OS closes the socket with the process, so the client
    learns immediately.

    "Promptly" is asserted against a 20s bound while the client's own
    timeout is 60s, so a failure here means a genuine hang rather than a
    slow machine.
    """
    process, base_url = proxy_subprocess

    started = time.monotonic()
    killed_at: float | None = None
    error: BaseException | None = None
    chunks_before_kill = 0

    with httpx.Client(timeout=60.0) as client:
        try:
            with client.stream("GET", f"{base_url}/sse-forever") as response:
                assert response.status_code == 200
                for _ in response.iter_raw():
                    chunks_before_kill += 1
                    if chunks_before_kill == 3:
                        # Mid-flight: headers received, body still open.
                        process.send_signal(signal.SIGKILL)
                        killed_at = time.monotonic()
        except BaseException as exc:  # noqa: BLE001 - the failure IS the result
            error = exc

    assert chunks_before_kill >= 3, "stream never got going, so nothing was killed mid-flight"
    assert killed_at is not None

    elapsed_since_kill = time.monotonic() - killed_at
    assert elapsed_since_kill < 20.0, (
        f"client hung for {elapsed_since_kill:.1f}s after the proxy was killed"
    )

    # Either the stream ends (clean truncation) or the client raises a
    # transport error. Both are diagnosable; a hang is not. What must
    # NOT happen is a silent success that looks like a complete answer.
    if error is not None:
        assert isinstance(error, httpx.HTTPError), f"unexpected error type: {type(error).__name__}"

    total = time.monotonic() - started
    assert total < 30.0, f"whole interaction took {total:.1f}s"


def test_requests_after_the_proxy_dies_fail_immediately(
    proxy_subprocess: tuple[subprocess.Popen, str],
) -> None:
    """With the proxy gone, the next request is refused, not stalled.

    This is the state a user is actually in when the supervisor has not
    yet restarted the proxy. ECONNREFUSED is the right answer: it is
    instant, and ``klio doctor`` can turn it into a sentence.
    """
    process, base_url = proxy_subprocess

    process.send_signal(signal.SIGKILL)
    process.wait(timeout=10)

    started = time.monotonic()
    with httpx.Client(timeout=30.0) as client, pytest.raises(httpx.ConnectError):
        client.post(f"{base_url}/v1/messages", content=b"{}")
    elapsed = time.monotonic() - started

    assert elapsed < 5.0, f"connection to a dead proxy took {elapsed:.1f}s to fail"


def test_proxy_subprocess_serves_health_and_traffic(
    proxy_subprocess: tuple[subprocess.Popen, str],
) -> None:
    """The production entry point works, not just ``create_app``.

    ``python -m klio_proxy`` is what launchd, systemd and Docker run. A
    suite that only ever calls ``create_app`` would not notice the
    module entry point being broken.
    """
    _, base_url = proxy_subprocess
    with httpx.Client(timeout=15.0) as client:
        health = client.get(f"{base_url}/__klio/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"

        echoed = client.post(f"{base_url}/echo/v1/messages", content=b'{"ok":true}')
        assert echoed.status_code == 200


def test_bad_configuration_exits_rather_than_serving_wrong_traffic() -> None:
    """A malformed upstream URL must not silently fall back to a default.

    Booting anyway would point the user's traffic — and their API key —
    somewhere they did not ask for. Exiting non-zero lets the supervisor
    surface it.
    """
    env = {
        **os.environ,
        "KLIO_PROXY_UPSTREAM_URL": "not-a-url",
        "KLIO_PROXY_PORT": str(free_port()),
        "PYTHONPATH": os.path.join(os.path.dirname(os.path.dirname(__file__)), "src"),
    }
    result = subprocess.run(
        [sys.executable, "-m", "klio_proxy"],
        env=env,
        capture_output=True,
        timeout=60,
    )
    assert result.returncode == 2
    assert b"bad configuration" in result.stderr
    assert b"KLIO_PROXY_UPSTREAM_URL" in result.stderr
