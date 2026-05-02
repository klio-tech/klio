"""S3 raw-event storage. Append-only, encrypted, partitioned by user/session."""
import json
import uuid
from datetime import UTC, datetime
from typing import Any

import boto3

from klio_engine.crypto.envelope import EnvelopeEncrypter


class RawEventSink:
    """Stores raw transcripts/tool-calls/hook-payloads in S3.

    Object key format: raw/{user_id}/{session_id}/{ts_ms}-{kind}.json.enc
    Object body: nonce (12 bytes) + ciphertext (AES-256-GCM under the user's
    envelope key).
    """

    def __init__(self, *, bucket: str, region: str = "us-east-1") -> None:
        self._bucket = bucket
        self._client = boto3.client("s3", region_name=region)

    async def put(
        self,
        *,
        user_id: uuid.UUID,
        session_id: uuid.UUID,
        source_type: str,
        payload: dict[str, Any],
        envelope_key: bytes,
    ) -> str:
        ts_ms = int(datetime.now(UTC).timestamp() * 1000)
        key = f"raw/{user_id}/{session_id}/{ts_ms}-{source_type}.json.enc"
        plaintext = json.dumps(payload).encode("utf-8")

        enc = EnvelopeEncrypter(envelope_key=envelope_key)
        nonce, ciphertext = enc.encrypt(plaintext)
        body = nonce + ciphertext

        self._client.put_object(
            Bucket=self._bucket,
            Key=key,
            Body=body,
            ContentType="application/octet-stream",
        )
        return key
