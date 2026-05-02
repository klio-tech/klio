"""Wrapper around AWS KMS for envelope-key generation and unwrap."""
import boto3


class KMSClient:
    """Generates and unwraps 256-bit envelope keys via AWS KMS.

    The KMS master key is configured per environment via KLIO_KMS_KEY_ARN.
    For local dev / tests we use moto, which speaks the same boto3 surface.
    """

    def __init__(self, key_arn: str, region: str = "us-east-1") -> None:
        self._key_arn = key_arn
        self._client = boto3.client("kms", region_name=region)

    def generate_envelope_key(self) -> tuple[bytes, bytes]:
        """Generate a fresh 256-bit envelope key.

        Returns (plaintext_key, wrapped_key). The plaintext key MUST NOT be
        persisted; the wrapped key is what we store alongside the user record.
        """
        resp = self._client.generate_data_key(
            KeyId=self._key_arn, KeySpec="AES_256"
        )
        return resp["Plaintext"], resp["CiphertextBlob"]

    def unwrap_envelope_key(self, wrapped_key: bytes) -> bytes:
        resp = self._client.decrypt(
            CiphertextBlob=wrapped_key, KeyId=self._key_arn
        )
        return resp["Plaintext"]
