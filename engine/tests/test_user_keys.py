"""UserKeyService tests + end-to-end entry encryption."""
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.crypto.envelope import EnvelopeEncrypter
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.user_keys import UserKeyService


@pytest.mark.asyncio
async def test_provision_and_unwrap(session: AsyncSession, mock_kms: KMSClient) -> None:
    svc = UserKeyService(kms=mock_kms)
    u = User()
    session.add(u)
    await session.flush()

    plaintext = await svc.provision_user_key(session, u)
    assert len(plaintext) == 32

    await session.refresh(u)
    assert u.wrapped_envelope_key is not None

    again = await svc.unwrap_user_key(u)
    assert again == plaintext


@pytest.mark.asyncio
async def test_unwrap_without_provisioning_raises(
    session: AsyncSession, mock_kms: KMSClient
) -> None:
    svc = UserKeyService(kms=mock_kms)
    u = User()
    session.add(u)
    await session.flush()

    with pytest.raises(ValueError, match="no envelope key"):
        await svc.unwrap_user_key(u)


@pytest.mark.asyncio
async def test_full_entry_encryption_round_trip(
    session: AsyncSession, mock_kms: KMSClient
) -> None:
    svc = UserKeyService(kms=mock_kms)
    u = User()
    session.add(u)
    await session.flush()
    plaintext_key = await svc.provision_user_key(session, u)

    a = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=uuid.uuid4())
    s = Space(user_id=u.id, name="Default", slug="default")
    session.add_all([a, s])
    await session.flush()

    enc = EnvelopeEncrypter(envelope_key=plaintext_key)
    plaintext = b"User prefers Bun over npm."
    nonce, ct = enc.encrypt(plaintext)

    e = Entry(
        user_id=u.id, space_id=s.id, agent_id=a.id, kind=EntryKind.MEMORY,
        content_ciphertext=ct, content_nonce=nonce,
        confidence=1.0,
    )
    session.add(e)
    await session.flush()

    fetched = await session.get(Entry, e.id)
    assert fetched is not None

    recovered = await svc.unwrap_user_key(u)
    dec = EnvelopeEncrypter(envelope_key=recovered)
    assert dec.decrypt(fetched.content_nonce, fetched.content_ciphertext) == plaintext
