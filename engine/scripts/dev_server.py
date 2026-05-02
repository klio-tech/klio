"""Local-only development server.

Boots the engine with a persistent file-backed KMS (so envelope keys
survive engine restarts) and a moto-backed S3 (because raw-event
storage is not security-critical for local dev). For production use
the production-image entrypoint with real AWS credentials instead of
this script.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import boto3
from moto import mock_aws


def _resolve_dev_kms_path() -> str:
    """Where the local KMS master lives. Prefer env override, then
    `~/.klio/dev-kms.key`. Created on first run with 0600 perms."""
    explicit = os.getenv("KLIO_DEV_KMS_PATH")
    if explicit:
        return explicit
    return str(Path.home() / ".klio" / "dev-kms.key")


def main() -> None:
    # Persistent file-backed KMS for dev. Set BEFORE the app imports so
    # `Settings()` picks it up.
    os.environ.setdefault("KLIO_DEV_KMS_PATH", _resolve_dev_kms_path())

    # We still need a fake S3 for raw-event ingest. The S3 contents are
    # ephemeral by design (only `entries` table holds anything we care
    # about across restarts), so moto in-process is fine here.
    mocker = mock_aws()
    mocker.start()

    s3 = boto3.client("s3", region_name=os.getenv("KLIO_AWS_REGION", "us-east-1"))
    bucket = os.getenv("KLIO_S3_BUCKET", "klio-raw-events-dev")
    try:
        s3.create_bucket(Bucket=bucket)
    except Exception:
        pass

    print(f"DEV: KMS master = {os.environ['KLIO_DEV_KMS_PATH']}", file=sys.stderr)
    print(f"DEV: S3 bucket = {bucket}", file=sys.stderr)

    import uvicorn

    uvicorn.run(
        "klio_engine.api.main:app",
        host=os.getenv("KLIO_HOST", "127.0.0.1"),
        port=int(os.getenv("KLIO_PORT", "8000")),
        log_level=os.getenv("KLIO_LOG_LEVEL", "info").lower(),
        reload=False,
    )


if __name__ == "__main__":
    main()
