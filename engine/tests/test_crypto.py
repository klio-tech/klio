"""AES-GCM envelope encryption + KMS integration tests."""
import pytest
from cryptography.exceptions import InvalidTag

from klio_engine.crypto.envelope import EnvelopeEncrypter
from klio_engine.crypto.kms_client import KMSClient


def test_envelope_round_trip() -> None:
    enc = EnvelopeEncrypter(envelope_key=b"\x00" * 32)
    plaintext = b"User prefers TypeScript over JavaScript"
    nonce, ct = enc.encrypt(plaintext)
    assert len(nonce) == 12
    assert ct != plaintext
    assert enc.decrypt(nonce, ct) == plaintext


def test_envelope_unique_nonce() -> None:
    enc = EnvelopeEncrypter(envelope_key=b"\x01" * 32)
    nonces = {enc.encrypt(b"same plaintext")[0] for _ in range(100)}
    assert len(nonces) == 100


def test_envelope_tampered_ciphertext_rejected() -> None:
    enc = EnvelopeEncrypter(envelope_key=b"\x02" * 32)
    nonce, ct = enc.encrypt(b"hello")
    bad_ct = ct[:-1] + bytes([(ct[-1] + 1) % 256])
    with pytest.raises(InvalidTag):
        enc.decrypt(nonce, bad_ct)


def test_envelope_wrong_key_size() -> None:
    with pytest.raises(ValueError, match="32 bytes"):
        EnvelopeEncrypter(envelope_key=b"too-short")


def test_kms_generate_and_unwrap(mock_kms: KMSClient) -> None:
    plaintext, wrapped = mock_kms.generate_envelope_key()
    assert len(plaintext) == 32

    decrypted = mock_kms.unwrap_envelope_key(wrapped)
    assert decrypted == plaintext


def test_kms_envelope_encrypt_round_trip(mock_kms: KMSClient) -> None:
    """Real flow: KMS wraps key, EnvelopeEncrypter uses it, KMS unwraps later."""
    plaintext_key, wrapped = mock_kms.generate_envelope_key()

    enc = EnvelopeEncrypter(envelope_key=plaintext_key)
    nonce, ciphertext = enc.encrypt(b"sensitive data")

    # Later: only wrapped is persisted; reconstitute via KMS
    recovered_key = mock_kms.unwrap_envelope_key(wrapped)
    dec = EnvelopeEncrypter(envelope_key=recovered_key)
    assert dec.decrypt(nonce, ciphertext) == b"sensitive data"
