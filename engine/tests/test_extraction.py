"""Phase D tests: PII, extractor, raw events, transcript ingest e2e."""
from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from dataclasses import dataclass

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from klio_engine.api.auth import _mint_for_test
from klio_engine.api.main import build_app
from klio_engine.crypto.envelope import EnvelopeEncrypter
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.dependencies import get_kms
from klio_engine.services.extractor import FactExtractor
from klio_engine.services.pii import scrub_pii
from klio_engine.services.raw_events import RawEventSink

JWT_SECRET = "test-secret-do-not-use-in-prod"


# --- PII scrubber ---


def test_pii_redacts_email() -> None:
    assert "abhishek@oppla.ai" not in scrub_pii("Reach me at abhishek@oppla.ai please")
    assert "[EMAIL]" in scrub_pii("Reach me at abhishek@oppla.ai please")


def test_pii_redacts_ssn() -> None:
    assert "123-45-6789" not in scrub_pii("My SSN is 123-45-6789.")


def test_pii_redacts_credit_card() -> None:
    assert "4111 1111 1111 1111" not in scrub_pii("Charge 4111 1111 1111 1111 12/29")


def test_pii_redacts_aws_key() -> None:
    assert "AKIAIOSFODNN7EXAMPLE" not in scrub_pii("key=AKIAIOSFODNN7EXAMPLE")


def test_pii_passthrough() -> None:
    s = "User prefers TypeScript over JavaScript."
    assert scrub_pii(s) == s


# --- Extractor (stub mode) ---


@pytest.mark.asyncio
async def test_stub_extractor_pulls_memory() -> None:
    transcript = "USER: I prefer TypeScript over JavaScript. Always.\nASSISTANT: ok"
    e = FactExtractor(model="stub")
    out = await e.extract(transcript)
    assert any("TypeScript" in r.content for r in out)
    assert all(r.kind in {"memory", "decision", "plan", "observation", "note"} for r in out)


@pytest.mark.asyncio
async def test_stub_extractor_pulls_decision() -> None:
    transcript = "ASSISTANT: I'm going with PostHog over Mixpanel because it's cheaper."
    e = FactExtractor(model="stub")
    out = await e.extract(transcript)
    assert any(r.kind == "decision" for r in out)


@pytest.mark.asyncio
async def test_stub_extractor_handles_empty() -> None:
    e = FactExtractor(model="stub")
    out = await e.extract("nothing extractable here")
    assert isinstance(out, list)


# --- Raw event sink ---


@pytest.mark.asyncio
async def test_raw_events_round_trip() -> None:
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="klio-test-raw")

        sink = RawEventSink(bucket="klio-test-raw", region="us-east-1")
        user_id = uuid.uuid4()
        session_id = uuid.uuid4()
        payload = {"messages": [{"role": "user", "content": "hi"}]}
        envelope_key = b"\x00" * 32

        key = await sink.put(
            user_id=user_id,
            session_id=session_id,
            source_type="claude-code-session",
            payload=payload,
            envelope_key=envelope_key,
        )
        assert str(user_id) in key
        assert str(session_id) in key

        # Read back and decrypt
        obj = s3.get_object(Bucket="klio-test-raw", Key=key)
        body = obj["Body"].read()
        nonce, ct = body[:12], body[12:]
        enc = EnvelopeEncrypter(envelope_key=envelope_key)
        import json

        assert json.loads(enc.decrypt(nonce, ct)) == payload


# --- Transcript ingest endpoint (e2e) ---


@dataclass
class AuthCtx:
    user_id: uuid.UUID
    agent_id: uuid.UUID
    default_space_id: uuid.UUID
    access_token: str

    def auth_header(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}"}


@pytest.fixture
def app_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv(
        "KLIO_DATABASE_URL",
        "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio",
    )
    monkeypatch.setenv("KLIO_JWT_SIGNING_KEY", JWT_SECRET)
    monkeypatch.setenv("KLIO_EMBEDDING_MODEL", "stub")
    monkeypatch.setenv("KLIO_EXTRACTION_MODEL", "stub")

    import klio_engine.dependencies as deps

    deps._engine = None
    deps._factory = None

    with mock_aws():
        kms_low = boto3.client("kms", region_name="us-east-1")
        arn = kms_low.create_key()["KeyMetadata"]["Arn"]
        kms = KMSClient(key_arn=arn, region="us-east-1")

        app = build_app()
        app.dependency_overrides[get_kms] = lambda: kms
        with TestClient(app) as client:
            yield client

    deps._engine = None
    deps._factory = None


def _provision(client: TestClient) -> AuthCtx:
    body = {"agent_kind": "claude-code", "install_id": str(uuid.uuid4())}
    p = client.post("/v1/users/provision", json=body).json()
    user_id = uuid.UUID(p["user_id"])
    agent_id = uuid.UUID(p["agent_id"])
    return AuthCtx(
        user_id=user_id,
        agent_id=agent_id,
        default_space_id=uuid.UUID(p["default_space_id"]),
        access_token=_mint_for_test(
            JWT_SECRET, user_id, agent_id, ["read", "write", "admin"], ttl=3600
        ),
    )


def test_ingest_transcript_end_to_end(app_client: TestClient) -> None:
    ctx = _provision(app_client)
    body = {
        "session_id": str(uuid.uuid4()),
        "source_type": "claude-code-session",
        "messages": [
            {
                "role": "user",
                "content": (
                    "I prefer TypeScript over JavaScript and we are going with "
                    "Bun for this project. My email abhishek@oppla.ai shouldn't "
                    "be stored."
                ),
            },
            {"role": "assistant", "content": "Understood."},
        ],
    }
    r = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/ingest/transcript",
        json=body,
        headers=ctx.auth_header(),
    )
    assert r.status_code == 201, r.text
    payload = r.json()
    assert payload["extracted_count"] >= 1
    assert len(payload["written_entry_ids"]) == payload["extracted_count"]

    # Verify the email was scrubbed: list entries and confirm content has [EMAIL]
    listed = app_client.get(
        f"/v1/spaces/{ctx.default_space_id}/entries", headers=ctx.auth_header()
    ).json()
    contents = " ".join(r["content"] for r in listed)
    assert "abhishek@oppla.ai" not in contents


def test_ingest_requires_write_permission(app_client: TestClient) -> None:
    ctx_a = _provision(app_client)
    ctx_b = _provision(app_client)
    # Try to ingest into A's space using B's token
    body = {
        "session_id": str(uuid.uuid4()),
        "messages": [{"role": "user", "content": "I prefer Go."}],
    }
    r = app_client.post(
        f"/v1/spaces/{ctx_a.default_space_id}/ingest/transcript",
        json=body,
        headers=ctx_b.auth_header(),
    )
    assert r.status_code == 403
