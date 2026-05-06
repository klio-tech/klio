"""Anonymous-first user provisioning.

Single transactional flow that:
  1. Creates the User (anonymous unless email provided).
  2. Provisions the user's envelope key via KMS.
  3. Creates the Agent (caller-supplied kind + install_id).
  4. Creates the Default Space.
  5. Grants the agent admin scope on the Default Space.
  6. Issues a refresh token for the agent.
  7. Writes the audit-log entries for each privileged step.

Returns plaintext refresh_token (the API key handed back to the daemon).

Idempotency: if the supplied `install_id` matches an existing agent,
the new-user path is skipped entirely and the caller gets a fresh
refresh+access token bound to the OLDEST existing user with that
install_id (the one with the longest write history). This honours
the npm CLI's documented "klio init is idempotent — re-running gets
the same user back" contract. Pre-0.5.2 silently violated it,
creating a new anonymous user every run; users observed it as "all
my memories are gone".
"""
import hashlib
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.audit.writer import write_audit_event
from klio_engine.auth.refresh import issue_refresh_token
from klio_engine.config import Settings
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.permission import Permission, PermissionScope
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.embedding_models import resolve_or_synthesize
from klio_engine.services.user_keys import UserKeyService


@dataclass
class ProvisionResult:
    user_id: uuid.UUID
    agent_id: uuid.UUID
    api_key: str
    claimed: bool
    default_space_id: uuid.UUID


async def provision_user(
    session: AsyncSession,
    *,
    kms: KMSClient,
    agent_kind: str,
    install_id: uuid.UUID,
    display_name: str | None = None,
    email: str | None = None,
    refresh_ttl_days: int = 90,
) -> ProvisionResult:
    """Run the full provisioning flow.

    If `install_id` already exists in the agents table, the existing
    user (oldest by `agents.created_at`) is re-bound to a fresh
    refresh token and returned. No new User/Agent/Space rows are
    created in that case.
    """
    # 0. Idempotency: if this install_id has been seen before, return
    # the oldest existing user as a fresh session. The bridge always
    # calls with agent_kind="klio-bridge", and that's the only code
    # path that exercises this re-find today, so we key on
    # install_id alone. (A defensive future tightening could add
    # `Agent.kind == agent_kind` to the WHERE clause.)
    existing = await session.execute(
        select(Agent)
        .where(Agent.install_id == install_id)
        .order_by(Agent.created_at.asc())
        .limit(1)
    )
    existing_agent = existing.scalar_one_or_none()
    if existing_agent is not None:
        return await _refind_existing_user(
            session,
            agent=existing_agent,
            agent_kind=agent_kind,
            install_id=install_id,
            refresh_ttl_days=refresh_ttl_days,
        )

    # 1. User
    u = User()
    if email:
        u.email_hash = hashlib.sha256(email.encode()).hexdigest()
    session.add(u)
    await session.flush()

    # 2. Envelope key
    keys = UserKeyService(kms=kms)
    await keys.provision_user_key(session, u)

    # 3. Agent
    a = Agent(
        user_id=u.id,
        kind=AgentKind(agent_kind),
        install_id=install_id,
        display_name=display_name,
    )
    session.add(a)
    await session.flush()

    # 4. Default Space — pinned to the deployment's default embedding
    # model. The pin is permanent for the life of the space; switching
    # models requires `klio reembed --space <id> --to <model>`.
    #
    # `resolve_or_synthesize` lets non-registry model names (custom/*
    # and escape-hatch openrouter/* picks) succeed when the npm
    # onboarding has threaded the probed dim into KLIO_EMBEDDING_DIM —
    # without it, Phase 3 provision would hard-fail for any user who
    # picked Custom or typed an unknown OpenRouter model id.
    settings = Settings()
    spec = resolve_or_synthesize(
        settings.embedding_model, settings.embedding_dim
    )
    s = Space(
        user_id=u.id,
        name="Default",
        slug="default",
        embedding_model=spec.name,
        embedding_dim=spec.dim,
    )
    session.add(s)
    await session.flush()

    # 5. Admin permission
    p = Permission(
        user_id=u.id,
        space_id=s.id,
        agent_id=a.id,
        scope=PermissionScope.ADMIN,
        granted_by_agent_id=a.id,
    )
    session.add(p)
    await session.flush()

    # 6. Refresh token
    plaintext, _ = await issue_refresh_token(
        session, user_id=u.id, agent_id=a.id, ttl_days=refresh_ttl_days
    )

    # 7. Audit. `created=True` lets operators tell from the audit
    # chain whether a provision call created a fresh user or
    # re-found an existing one.
    await write_audit_event(
        session, user_id=u.id, actor_type="agent", actor_id=a.id,
        action="user.provision", target_type="user", target_id=u.id,
        metadata={
            "agent_kind": agent_kind,
            "install_id": str(install_id),
            "created": True,
        },
    )
    await write_audit_event(
        session, user_id=u.id, actor_type="agent", actor_id=a.id,
        action="space.create", target_type="space", target_id=s.id,
        metadata={"name": "Default", "slug": "default"},
    )
    await write_audit_event(
        session, user_id=u.id, actor_type="agent", actor_id=a.id,
        action="permission.grant", target_type="permission", target_id=p.id,
        metadata={"space_id": str(s.id), "agent_id": str(a.id), "scope": "admin"},
    )

    return ProvisionResult(
        user_id=u.id,
        agent_id=a.id,
        api_key=plaintext,
        claimed=u.claimed_at is not None,
        default_space_id=s.id,
    )


async def _refind_existing_user(
    session: AsyncSession,
    *,
    agent: Agent,
    agent_kind: str,
    install_id: uuid.UUID,
    refresh_ttl_days: int,
) -> ProvisionResult:
    """Idempotent re-find branch.

    Loads the user + default Space for the given agent, mints a fresh
    refresh token, and writes an audit-log row recording that this
    call did NOT create a new user (`metadata.created == False`).
    Returns the same ProvisionResult shape as the new-user path so
    callers don't need to know which branch ran.
    """
    user = await session.get(User, agent.user_id)
    if user is None:
        # The Agent FK has ON DELETE CASCADE on user_id, so this is
        # only reachable if the row was hand-deleted. Surface a
        # clear error rather than silently re-creating; an operator
        # is doing something unusual.
        raise RuntimeError(
            f"Agent {agent.id} references missing user {agent.user_id}; "
            "refusing to re-provision into an inconsistent state"
        )

    space_row = await session.execute(
        select(Space).where(
            Space.user_id == user.id,
            Space.slug == "default",
        )
    )
    space = space_row.scalar_one_or_none()
    if space is None:
        # Same reasoning as above: only reachable via hand-deletion
        # or a migration that fell over partway. Don't paper over it.
        raise RuntimeError(
            f"User {user.id} has no default space; refusing to "
            "re-provision into an inconsistent state"
        )

    plaintext, _ = await issue_refresh_token(
        session,
        user_id=user.id,
        agent_id=agent.id,
        ttl_days=refresh_ttl_days,
    )

    await write_audit_event(
        session,
        user_id=user.id,
        actor_type="agent",
        actor_id=agent.id,
        action="user.provision",
        target_type="user",
        target_id=user.id,
        metadata={
            "agent_kind": agent_kind,
            "install_id": str(install_id),
            "created": False,
        },
    )

    return ProvisionResult(
        user_id=user.id,
        agent_id=agent.id,
        api_key=plaintext,
        claimed=user.claimed_at is not None,
        default_space_id=space.id,
    )
