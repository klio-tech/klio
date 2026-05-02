"""AES-256-GCM envelope encryption."""
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class EnvelopeEncrypter:
    """Encrypts plaintext with a 256-bit key using AES-256-GCM.

    The envelope key is held in memory only. It is unwrapped from KMS by the
    caller (see kms_client.py) before being passed in.
    """

    def __init__(self, envelope_key: bytes) -> None:
        if len(envelope_key) != 32:
            raise ValueError("envelope_key must be 32 bytes (256 bits)")
        self._aead = AESGCM(envelope_key)

    def encrypt(self, plaintext: bytes, *, aad: bytes | None = None) -> tuple[bytes, bytes]:
        """Returns (nonce, ciphertext_with_auth_tag)."""
        nonce = os.urandom(12)
        ct = self._aead.encrypt(nonce, plaintext, aad)
        return nonce, ct

    def decrypt(
        self, nonce: bytes, ciphertext: bytes, *, aad: bytes | None = None
    ) -> bytes:
        return self._aead.decrypt(nonce, ciphertext, aad)
