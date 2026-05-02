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
"""
import hashlib
import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.audit.writer import write_audit_event
from klio_engine.auth.refresh import issue_refresh_token
from klio_engine.config import Settings
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.permission import Permission, PermissionScope
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.embedding_models import resolve as resolve_embed_model
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
    """Run the full provisioning flow."""
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
    spec = resolve_embed_model(Settings().embedding_model)
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

    # 7. Audit
    await write_audit_event(
        session, user_id=u.id, actor_type="agent", actor_id=a.id,
        action="user.provision", target_type="user", target_id=u.id,
        metadata={"agent_kind": agent_kind, "install_id": str(install_id)},
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
