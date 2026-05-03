#!/bin/sh
# Engine container entrypoint.
#
# Runs Alembic migrations to head, then boots the dev server. The
# dev_server script handles persistent file-backed KMS init + moto S3
# bootstrapping; we just wait for Postgres before applying migrations
# so a fresh `docker compose up` doesn't race the database init.

set -e

echo "[entrypoint] waiting for postgres at $KLIO_DATABASE_URL ..."
python - <<'PY'
import os
import time
import socket
import urllib.parse as up

url = os.getenv("KLIO_DATABASE_URL", "")
parsed = up.urlparse(url.replace("+asyncpg", ""))
host = parsed.hostname or "postgres"
port = parsed.port or 5432

deadline = time.time() + 60
while time.time() < deadline:
    try:
        with socket.create_connection((host, port), timeout=2):
            print(f"[entrypoint] postgres reachable at {host}:{port}")
            break
    except OSError:
        time.sleep(1)
else:
    raise SystemExit(f"[entrypoint] postgres at {host}:{port} did not become reachable in 60s")
PY

echo "[entrypoint] running migrations ..."
alembic upgrade head

echo "[entrypoint] booting dev_server ..."
exec python scripts/dev_server.py
