"""Entry point: ``python -m klio_proxy`` / ``klio-proxy``.

Kept deliberately thin. The supervisor (launchd, systemd, Docker) runs
this, and anything clever here is something that can fail before the
proxy is listening — at which point the agent has an
``ANTHROPIC_BASE_URL`` pointing at a closed port and no way to reach a
model.

A single worker, no reload, no auto-discovery. The proxy is I/O bound
and asyncio handles the concurrency; extra workers would only multiply
the connection pools.
"""

from __future__ import annotations

import logging
import sys

import uvicorn

from .app import create_app
from .config import load_config


def main(argv: list[str] | None = None) -> int:
    """Boot the proxy. Returns a process exit code."""
    del argv  # configuration is environment-only; see config.py

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    try:
        config = load_config()
    except ValueError as exc:
        # Configuration errors are the one class of failure worth dying
        # on: the supervisor will restart us, we will fail identically,
        # and the log will say exactly which variable is wrong. Starting
        # anyway with a silently substituted default would point the
        # user's traffic somewhere they did not ask for.
        sys.stderr.write(f"klio-proxy: bad configuration: {exc}\n")
        return 2

    uvicorn.run(
        create_app(config),
        host=config.host,
        port=config.port,
        # uvicorn's access log would record one line per model call,
        # including full paths, into a file nobody rotates. The proxy
        # logs failures; it does not log traffic.
        access_log=False,
        log_level="info",
        # A transparent proxy must not sign its own work. uvicorn adds
        # `server: uvicorn` and its own `date` header by default; since
        # we forward the upstream's `server` and `date` verbatim, leaving
        # these on produces DUPLICATE headers on every response and tells
        # the client it is talking to uvicorn rather than to Anthropic.
        server_header=False,
        date_header=False,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised as a subprocess
    raise SystemExit(main())
