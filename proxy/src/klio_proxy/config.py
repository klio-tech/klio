"""Runtime configuration for the proxy.

Read from the process environment, with defaults that work for a fresh
install and no config file to go stale. Everything is validated at
construction so a typo surfaces at boot — when the supervisor will
report it — rather than on the first request the agent makes.

Plain dataclass + ``os.environ`` rather than pydantic-settings (which
the engine uses): the proxy's dependency list is a reliability budget,
not a style choice. See the note in ``pyproject.toml``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

#: Where the proxy forwards to when nothing overrides it.
DEFAULT_UPSTREAM_BASE_URL = "https://api.anthropic.com"

#: Port from the Klio Compression design doc. Chosen to be memorable and
#: outside the range agents and dev servers usually squat on.
DEFAULT_PORT = 8787

#: Bound to loopback by default. The proxy carries the user's Anthropic
#: credentials in every request it forwards; exposing it on 0.0.0.0 turns
#: the machine into an open relay for whoever can reach the port. The
#: container image overrides this to 0.0.0.0 because Docker's own port
#: publishing (``127.0.0.1:8787:8787``) is what enforces the boundary
#: there.
DEFAULT_HOST = "127.0.0.1"

#: Seconds to wait for a TCP connection + TLS handshake with the upstream.
#: Short, because a connect that has not happened in this long is not
#: going to: failing fast gives the agent a diagnosable error instead of
#: a hang.
DEFAULT_CONNECT_TIMEOUT = 10.0

#: Read timeout. ``None`` means "no limit", which is correct and load
#: bearing: a long agentic turn with extended thinking can legitimately
#: stream for many minutes with gaps between SSE events. Any finite value
#: here is a clock that eventually cuts off a working session.
DEFAULT_READ_TIMEOUT: float | None = None


@dataclass(frozen=True)
class ProxyConfig:
    """Immutable snapshot of the proxy's configuration."""

    upstream_base_url: str = DEFAULT_UPSTREAM_BASE_URL
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    connect_timeout: float = DEFAULT_CONNECT_TIMEOUT
    read_timeout: float | None = DEFAULT_READ_TIMEOUT

    def __post_init__(self) -> None:
        if not self.upstream_base_url.startswith(("http://", "https://")):
            raise ValueError(
                f"KLIO_PROXY_UPSTREAM_URL must start with http:// or https://, got "
                f"{self.upstream_base_url!r}"
            )
        if not 1 <= self.port <= 65535:
            raise ValueError(f"KLIO_PROXY_PORT must be 1-65535, got {self.port}")
        if self.connect_timeout <= 0:
            raise ValueError(
                f"KLIO_PROXY_CONNECT_TIMEOUT must be positive, got {self.connect_timeout}"
            )

    @property
    def upstream_origin(self) -> str:
        """Upstream base URL with any trailing slash removed.

        Request paths always arrive with a leading ``/``, so keeping a
        trailing slash here would produce ``https://host//v1/messages``.
        Anthropic tolerates that; a self-hosted gateway pointed at by
        ``KLIO_PROXY_UPSTREAM_URL`` may well not.
        """
        return self.upstream_base_url.rstrip("/")


def load_config(environ: dict[str, str] | None = None) -> ProxyConfig:
    """Build a :class:`ProxyConfig` from the environment.

    ``environ`` is injectable so tests can exercise parsing without
    mutating global process state.

    Raises ``ValueError`` with the offending variable named, so a
    misconfigured supervisor unit produces a log line someone can act on
    rather than a stack trace deep in uvicorn.
    """
    env = os.environ if environ is None else environ

    return ProxyConfig(
        upstream_base_url=env.get("KLIO_PROXY_UPSTREAM_URL", DEFAULT_UPSTREAM_BASE_URL),
        host=env.get("KLIO_PROXY_HOST", DEFAULT_HOST),
        port=_int_env(env, "KLIO_PROXY_PORT", DEFAULT_PORT),
        connect_timeout=_float_env(env, "KLIO_PROXY_CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT),
        read_timeout=_optional_float_env(env, "KLIO_PROXY_READ_TIMEOUT", DEFAULT_READ_TIMEOUT),
    )


def _int_env(env: dict[str, str], key: str, default: int) -> int:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be an integer, got {raw!r}") from exc


def _float_env(env: dict[str, str], key: str, default: float) -> float:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be a number, got {raw!r}") from exc


def _optional_float_env(env: dict[str, str], key: str, default: float | None) -> float | None:
    """Like :func:`_float_env` but where the literal ``none`` means no limit."""
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    if raw.strip().lower() in {"none", "off", "0"}:
        return None
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be a number or 'none', got {raw!r}") from exc
