# Image for the Klio compression proxy.
#
# Kept separate from the engine image on purpose. The engine pulls in
# sqlalchemy, asyncpg, cryptography, boto3 and pgvector; the proxy needs
# an HTTP server and an HTTP client. Sharing a base would put ~200 MB of
# unrelated wheels — and every CVE and import-time failure in them — into
# the critical path of the user's model calls.
#
# Single-stage: with three pure-Python-plus-wheels dependencies there is
# nothing to compile, so a builder stage would add complexity and save
# nothing.

FROM python:3.12-slim

# uvloop/httptools ship as manylinux wheels, so no build toolchain is
# needed. Nothing to apt-get install.

WORKDIR /app

# Dependencies first so a source-only change does not re-resolve them.
# The versions mirror the `dependencies` list in pyproject.toml —
# keep them in sync; a drift here surfaces as a proxy that will not
# start, which is the worst possible time to find out.
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir \
        "fastapi>=0.115" \
        "uvicorn[standard]>=0.32" \
        "httpx>=0.27"

COPY pyproject.toml README.md ./
COPY src/ ./src/

ENV PYTHONPATH=/app/src
# Do not buffer stdout: the supervisor and `docker logs` are the only
# window into a proxy that is failing to start, and a buffered crash
# message is a crash message nobody sees.
ENV PYTHONUNBUFFERED=1

# Bind all interfaces INSIDE the container. This is not a weaker
# posture than the host default of 127.0.0.1: the compose file
# publishes the port as `127.0.0.1:8787:8787`, so the container's
# network namespace is the boundary and Docker enforces loopback-only
# reachability from outside. Binding 127.0.0.1 inside the container
# would make the published port unreachable.
ENV KLIO_PROXY_HOST=0.0.0.0
ENV KLIO_PROXY_PORT=8787

EXPOSE 8787

# Liveness only — deliberately does not probe api.anthropic.com. A
# healthcheck that depended on the upstream would let an Anthropic
# outage or a flaky network restart-loop a perfectly healthy proxy,
# turning someone else's problem into ours.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8787/__klio/health', timeout=2).status==200 else 1)"

ENTRYPOINT ["python", "-m", "klio_proxy"]
