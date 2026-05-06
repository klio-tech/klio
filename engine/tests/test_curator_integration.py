"""End-to-end curator integration test.

Wires the real PgObservationReader + PgCursorStore + CuratorWriter +
stub FactExtractor against the test Postgres + the moto-backed KMS,
seeds a small batch of observations, calls Curator.run_once, asserts
the synthesis loop runs end-to-end. The unit tests in test_curator.py
prove the Curator's own logic; this test proves the four collaborators
actually fit together against real SQL."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select

from klio_engine.crypto.envelope import EnvelopeEncrypter
from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.curator import Curator
from klio_engine.services.curator_pg import (
    DecryptingObservationReader,
    PgCursorStore,
)
from klio_engine.services.curator_writer import CuratorWriter
from klio_engine.services.extractor import FactExtractor
from klio_engine.services.user_keys import UserKeyService


pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _hermetic_settings_env(monkeypatch):
    """Deterministic env so EmbeddingService + Settings don't need
    an external KLIO_*."""
    monkeypatch.setenv(
        "KLIO_DATABASE_URL",
        "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio",
    )
    monkeypatch.setenv("KLIO_EMBEDDING_MODEL", "stub")
    monkeypatch.setenv("KLIO_EXTRACTION_MODEL", "stub")


@pytest_asyncio.fixture
async def seed_full_user(session, mock_kms) -> uuid.UUID:
    """A user (with envelope key) + default space + observation-laden
    agent. Returns the user's id; the rest of the fixtures are reachable
    via the session.

    Observations are encrypted with the user's real envelope key so the
    DecryptingObservationReader path exercises the same KMS-unwrap +
    AES-256-GCM round-trip a production tick would."""
    user = User(id=uuid.uuid4())
    session.add(user)
    await session.flush()  # User must exist before child rows reference user_id.

    plaintext_key = await UserKeyService(mock_kms).provision_user_key(
        session, user
    )
    envelope = EnvelopeEncrypter(envelope_key=plaintext_key)

    space = Space(
        id=uuid.uuid4(),
        user_id=user.id,
        name="Default",
        slug="default",
        embedding_model="stub",
        embedding_dim=1536,
    )
    session.add(space)
    agent = Agent(
        id=uuid.uuid4(),
        user_id=user.id,
        display_name="Test agent",
        kind=AgentKind.CLAUDE_CODE,
        install_id=uuid.uuid4(),
    )
    session.add(agent)
    await session.flush()

    base = datetime.now(timezone.utc) - timedelta(hours=1)
    contents = [
        "user prefers Bun runtime over Node and npm for JavaScript projects",
        "we'll use Railway for hosting, not Fly.io",
        "decided to deploy via GitHub Actions to staging on every PR merge",
        "user said remember that the npm package is @klio-tech/klio",
    ]
    for i, content in enumerate(contents):
        nonce, ct = envelope.encrypt(content.encode("utf-8"))
        e = Entry(
            id=uuid.uuid4(),
            user_id=user.id,
            space_id=space.id,
            agent_id=agent.id,
            kind=EntryKind.OBSERVATION,
            content_nonce=nonce,
            content_ciphertext=ct,
            created_at=base + timedelta(minutes=i),
        )
        session.add(e)
    await session.flush()
    return user.id


async def test_curator_end_to_end_with_stub_extractor(
    session, mock_kms, seed_full_user
):
    """Full pipeline against real Postgres + stub LLM:
    - read observations since cursor
    - run them through FactExtractor(stub) — produces deterministic
      regex-based ExtractedEntry items
    - write the synthesised entries through CuratorWriter
    - advance the cursor

    Asserts: at least one entry of kind in {memory, decision, plan,
    note} exists for seed_full_user, written by the klio-curator
    agent; the cursor advanced past the latest seeded observation."""
    reader = DecryptingObservationReader(session=session, kms=mock_kms)
    extractor = FactExtractor(model="stub")
    writer = CuratorWriter(session=session, kms=mock_kms)
    store = PgCursorStore(session=session)
    curator = Curator(
        reader=reader,
        extractor=extractor,
        writer=writer,
        store=store,
    )

    await curator.run_once(user_id=seed_full_user, batch_size=50)
    await session.commit()

    # Cursor advanced.
    from klio_engine.models.curator_state import CuratorState
    session.expire_all()
    state = (await session.execute(
        select(CuratorState).where(CuratorState.user_id == seed_full_user)
    )).scalar_one()
    assert state.last_synthesized > 0, (
        f"stub extractor produced 0 entries — regex rules may have "
        f"changed; see services/extractor.py:_STUB_RULES"
    )
    assert state.last_error is None
    assert state.last_cursor_at > datetime(2026, 1, 1, tzinfo=timezone.utc)

    # At least one synthesised entry exists, written by the curator agent.
    curator_agent = (await session.execute(
        select(Agent)
        .where(Agent.user_id == seed_full_user)
        .where(Agent.display_name == "klio-curator")
    )).scalar_one()
    synthesised = (await session.execute(
        select(Entry)
        .where(Entry.user_id == seed_full_user)
        .where(Entry.agent_id == curator_agent.id)
    )).scalars().all()
    assert len(synthesised) >= 1
    kinds = {e.kind for e in synthesised}
    assert kinds.issubset({
        EntryKind.MEMORY,
        EntryKind.DECISION,
        EntryKind.PLAN,
        EntryKind.NOTE,
    }), f"unexpected kind in {kinds}"
