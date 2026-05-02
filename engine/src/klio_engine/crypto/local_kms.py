"""File-backed KMS for local development.

Production deployments use AWS KMS via `KMSClient` (or a comparable
managed-key service on GCP/Azure). For `klio dev` we need a KMS that:

  * survives engine restarts (so a user provisioned today can still
    decrypt their entries tomorrow); and
  * does not require AWS credentials (for free self-hosters).

`LocalFileKMSClient` stores a single 256-bit master key at a
configurable path on disk, generated on first run with permissions
0600. Envelope keys are wrapped under the master using AES-256-GCM
with a fresh 12-byte nonce per wrap; the on-wire format is
`nonce (12 bytes) || ciphertext-and-tag`. The interface is the same as
the AWS-backed `KMSClient`, so the rest of the engine is oblivious to
which backend is in use.

Security notes:
  * The master key is unencrypted on disk. This is acceptable for local
    dev where the OS user already has full filesystem access. NEVER use
    this in multi-tenant production.
  * Loss of the master file = loss of every entry's plaintext. For dev
    this is fine; a user can simply re-provision.
"""
from __future__ import annotations

import os
import secrets
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_MASTER_KEY_BYTES = 32  # AES-256
_NONCE_BYTES = 12
_GCM_TAG_BYTES = 16


class LocalFileKMSClient:
    """File-backed master-key KMS. Mirrors AWS `KMSClient` interface."""

    def __init__(self, master_path: str | Path) -> None:
        self._master_path = Path(master_path).expanduser()
        self._master = self._load_or_create_master()

    def _load_or_create_master(self) -> bytes:
        if self._master_path.exists():
            data = self._master_path.read_bytes()
            if len(data) != _MASTER_KEY_BYTES:
                raise ValueError(
                    f"corrupt KMS master at {self._master_path}: "
                    f"expected {_MASTER_KEY_BYTES} bytes, got {len(data)}"
                )
            return data
        self._master_path.parent.mkdir(parents=True, exist_ok=True)
        # 0600 perms on the master file. We use os.open with O_CREAT+O_EXCL
        # so an attacker cannot pre-seat a chosen master via a race window.
        fd = os.open(
            self._master_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        try:
            master = secrets.token_bytes(_MASTER_KEY_BYTES)
            os.write(fd, master)
            return master
        finally:
            os.close(fd)

    def generate_envelope_key(self) -> tuple[bytes, bytes]:
        """Return `(plaintext_key, wrapped_key)`. Plaintext MUST NOT be persisted."""
        plaintext = secrets.token_bytes(_MASTER_KEY_BYTES)
        nonce = secrets.token_bytes(_NONCE_BYTES)
        wrapped = AESGCM(self._master).encrypt(nonce, plaintext, None)
        return plaintext, nonce + wrapped

    def unwrap_envelope_key(self, wrapped_key: bytes) -> bytes:
        if len(wrapped_key) < _NONCE_BYTES + _GCM_TAG_BYTES:
            raise ValueError(
                f"wrapped key too short: {len(wrapped_key)} bytes "
                f"(need >= {_NONCE_BYTES + _GCM_TAG_BYTES})"
            )
        nonce, ct = wrapped_key[:_NONCE_BYTES], wrapped_key[_NONCE_BYTES:]
        return AESGCM(self._master).decrypt(nonce, ct, None)
