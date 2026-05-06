"""CuratorWriter — bridges the Curator's flat-kwargs EntryWriter
Protocol to EntryService.write.

The Curator (services/curator.py) hands synthesised entries off via a
Protocol whose only method is `async def write(self, **kwargs) -> None`.
That keeps the Curator agnostic of per-user identity routing — but
something has to fill in the (space_id, agent_id) pair that
EntryService.write demands. CuratorWriter is that seam.

For each write it:

  1. Resolves the user's *default* space by `slug='default'`. The
     curator never invents spaces; if the user has none, it raises.
     Space provisioning is its own ceremony (embedding-model pinning +
     audit chain) handled by `services.provisioning`.

  2. Resolves a deterministic per-user `klio-curator` agent. First
     tick for that user creates it lazily; every later tick reuses
     it. The kind is `AgentKind.KLIO_BRIDGE` — the closest fit for a
     Klio-internal system agent — but what makes it visually distinct
     in `recall` and the trust-app timeline is its
     `display_name="klio-curator"`.

  3. Forwards through `EntryService.write` so synthesised entries take
     the same encrypted-write + dedup + audit-chain path a user-driven
     write does. No shortcut, no separate code path to keep in sync.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.entry import EntryKind
from klio_engine.models.space import Space
from klio_engine.services.embeddings import EmbeddingService
from klio_engine.services.entries import EntryService


# Stable identifier surfaced in `recall` and the trust-app timeline.
# Treat as a contract: changing this breaks every existing curator
# entry's provenance attribution at the UI layer.
CURATOR_DISPLAY_NAME = "klio-curator"

# `AgentKind` has no SYSTEM variant in v0; KLIO_BRIDGE is the closest
# fit for a Klio-internal synthesiser. Display-name is what makes the
# curator distinct in the UI; kind is informational only.
_CURATOR_AGENT_KIND = AgentKind.KLIO_BRIDGE


class CuratorWriter:
    """EntryWriter Protocol implementation that pins synthesised
    entries to (default_space, klio-curator agent) for the target user.

    One instance per Curator tick is fine — `EntryService` is stateless
    aside from its injected dependencies, and SQLAlchemy session usage
    is delegated through to the caller's session.
    """

    def __init__(
        self,
        *,
        session: AsyncSession,
        kms: KMSClient,
        dedup_threshold: float,
        entry_service: EntryService | None = None,
    ) -> None:
        """
        `dedup_threshold` is injected (rather than re-derived from
        `Settings()` per construction) because CuratorWriter is built
        once per scheduler tick and once per `run-now` request — re-
        parsing the env on every tick was a measurable hot path.
        Callers pass `settings.dedup_cosine_threshold` from a single
        Settings instance constructed at lifespan time.

        `entry_service` is overridable so tests can inject a stub
        without standing up an EmbeddingService. In production the
        default constructor wiring is what every call site uses.
        """
        self._session = session
        self._entry_service = entry_service or EntryService(
            kms=kms,
            embeddings=EmbeddingService(),
            dedup_threshold=dedup_threshold,
        )

    async def write(self, **kwargs: Any) -> None:
        """Write a synthesised entry. Required kwargs:

            user_id: uuid.UUID
            kind:    str — one of EntryKind values
            content: str

        Optional kwargs:

            confidence: float (defaults to 1.0)
            metadata:   dict | None
            session_id: uuid.UUID | None
        """
        user_id: uuid.UUID = kwargs["user_id"]
        space_id = await self._default_space_id(user_id)
        agent_id = await self._curator_agent_id(user_id)

        await self._entry_service.write(
            self._session,
            user_id=user_id,
            space_id=space_id,
            agent_id=agent_id,
            kind=EntryKind(kwargs["kind"]),
            content=kwargs["content"],
            metadata=kwargs.get("metadata"),
            confidence=kwargs.get("confidence", 1.0),
            session_id=kwargs.get("session_id"),
        )

    async def _default_space_id(self, user_id: uuid.UUID) -> uuid.UUID:
        """Look up the user's default space by `slug='default'`.

        `slug` (not `name`) is the per-user routing key — it's the
        column under the `uq_space_user_slug` unique constraint, so
        looking it up is unambiguous. Production uses
        `name='Default'` (display) + `slug='default'` (routing); the
        curator only cares about routing.
        """
        space = (
            await self._session.execute(
                select(Space)
                .where(Space.user_id == user_id)
                .where(Space.slug == "default")
                .where(Space.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if space is None:
            raise RuntimeError(
                f"user {user_id} has no default space — curator cannot "
                "synthesise without a target space; provision one via "
                "services.provisioning before enabling the curator"
            )
        return space.id

    async def _curator_agent_id(self, user_id: uuid.UUID) -> uuid.UUID:
        """Resolve (lazily create) the per-user klio-curator agent.

        Looked up by (user_id, display_name) rather than by the
        unique-constraint columns (user_id, kind, install_id) so the
        binding is stable across install_id rotations — the curator
        is conceptually one logical agent per user, not per install.

        First tick for this user creates the row with a fresh
        install_id. Every tick after reuses it.
        """
        agent = (
            await self._session.execute(
                select(Agent)
                .where(Agent.user_id == user_id)
                .where(Agent.display_name == CURATOR_DISPLAY_NAME)
                .where(Agent.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if agent is not None:
            return agent.id

        agent = Agent(
            user_id=user_id,
            kind=_CURATOR_AGENT_KIND,
            install_id=uuid.uuid4(),
            display_name=CURATOR_DISPLAY_NAME,
        )
        self._session.add(agent)
        await self._session.flush()
        return agent.id
