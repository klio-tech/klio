"""Local-only development server.

Wraps uvicorn with moto so the engine can run end-to-end against a fake
KMS without requiring AWS credentials. Production uses real AWS KMS;
this script is for `klio dev` workflows only.
"""
from __future__ import annotations

import os
import sys

import boto3
from moto import mock_aws


def main() -> None:
    mocker = mock_aws()
    mocker.start()

    kms = boto3.client("kms", region_name=os.getenv("KLIO_AWS_REGION", "us-east-1"))
    arn = kms.create_key(Description="klio-dev")["KeyMetadata"]["Arn"]
    os.environ["KLIO_KMS_KEY_ARN"] = arn

    s3 = boto3.client("s3", region_name=os.getenv("KLIO_AWS_REGION", "us-east-1"))
    bucket = os.getenv("KLIO_S3_BUCKET", "klio-raw-events-dev")
    try:
        s3.create_bucket(Bucket=bucket)
    except Exception:
        pass

    print(f"DEV: KMS arn = {arn}", file=sys.stderr)
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
