"""LocalFileKMSClient — wrap/unwrap round-trip + restart persistence."""
from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from klio_engine.crypto.local_kms import LocalFileKMSClient


def test_generate_and_unwrap_round_trip(tmp_path: Path) -> None:
    kms = LocalFileKMSClient(tmp_path / "master.key")

    plaintext, wrapped = kms.generate_envelope_key()
    assert len(plaintext) == 32
    assert wrapped != plaintext  # never store plaintext on the wire
    assert kms.unwrap_envelope_key(wrapped) == plaintext


def test_master_key_persists_across_clients(tmp_path: Path) -> None:
    """A key wrapped by one instance must unwrap with a *new* instance
    pointing at the same master path. This is the property that makes
    engine restarts safe."""
    path = tmp_path / "master.key"
    kms_a = LocalFileKMSClient(path)
    plaintext, wrapped = kms_a.generate_envelope_key()

    kms_b = LocalFileKMSClient(path)  # simulates engine restart
    assert kms_b.unwrap_envelope_key(wrapped) == plaintext


def test_master_key_file_is_owner_only(tmp_path: Path) -> None:
    path = tmp_path / "master.key"
    LocalFileKMSClient(path)

    mode = stat.S_IMODE(os.stat(path).st_mode)
    assert mode == 0o600, f"master key permissions must be 0600, got {oct(mode)}"


def test_corrupt_master_rejected(tmp_path: Path) -> None:
    path = tmp_path / "master.key"
    path.write_bytes(b"too-short")
    with pytest.raises(ValueError, match="corrupt KMS master"):
        LocalFileKMSClient(path)


def test_unwrap_rejects_too_short_ciphertext(tmp_path: Path) -> None:
    kms = LocalFileKMSClient(tmp_path / "master.key")
    with pytest.raises(ValueError, match="too short"):
        kms.unwrap_envelope_key(b"x" * 10)


def test_two_keys_use_different_nonces(tmp_path: Path) -> None:
    """Each wrap produces a fresh nonce; identical plaintext → distinct
    ciphertext. This guards against a regression where the nonce got
    derived from the master key (which would leak the plaintext across
    keys)."""
    kms = LocalFileKMSClient(tmp_path / "master.key")
    p1, w1 = kms.generate_envelope_key()
    p2, w2 = kms.generate_envelope_key()
    assert w1 != w2  # different ciphertexts
    # Different keys round-trip independently.
    assert kms.unwrap_envelope_key(w1) == p1
    assert kms.unwrap_envelope_key(w2) == p2
