"""Agent model — a specific install of an MCP-capable agent."""
import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from klio_engine.models.base import Base


class AgentKind(str, enum.Enum):
    """Known agent kinds. CUSTOM is for SDK consumers."""

    CLAUDE_CODE = "claude-code"
    CURSOR = "cursor"
    CODEX = "codex"
    ANTIGRAVITY = "antigravity"
    KLIO_BRIDGE = "klio-bridge"
    CUSTOM = "custom"


class Agent(Base):
    """A specific agent install. (user_id, kind, install_id) is unique."""

    __tablename__ = "agents"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "kind", "install_id", name="uq_agent_user_kind_install"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind: Mapped[AgentKind] = mapped_column(
        Enum(
            AgentKind,
            name="agent_kind",
            values_callable=lambda obj: [e.value for e in obj],
        ),
        nullable=False,
    )
    install_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
