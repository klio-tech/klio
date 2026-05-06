"""System-level metadata routes — currently `/banners`.

The banners endpoint surfaces UI-level prompts the dashboard
should render to the authenticated user. v0.6.0 ships exactly one
banner kind (`claim_email`); future kinds will be added as their
producers land (see companion design doc
`docs/plans/2026-05-07-email-claim-and-auto-update-design.md`).

Logic — strictly cheap reads:
  - claim_email: emit when `users.claimed_at IS NULL` (the unclaimed
    anonymous-account state). The dashboard renders a banner that
    POSTs the user's email to `/v1/auth/login-link`, which is what
    upgrades the row out of the anonymous state.

The router shape (a flat `{"banners": [...]}` envelope where each
entry carries `kind`, `severity`, `title`, `body`, and an optional
structured `action`) is intentionally generic so future kinds
(`update_available`, `update_failed`, etc.) can be appended by their
respective producers without changing the wire shape or this file's
public signature.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.dependencies import get_session
from klio_engine.models.user import User


router = APIRouter(prefix="/v1/system", tags=["system"])


@router.get("/banners")
async def banners(
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Return the list of banners the dashboard should render.

    Every entry is a self-contained dict the frontend can render
    without further server round-trips. The order in the list is the
    suggested render order (most-relevant first); v0.6.0 only emits
    one kind, so order is trivial today.
    """
    user = (
        await session.execute(select(User).where(User.id == ctx.user_id))
    ).scalar_one()

    out: list[dict] = []

    # claim_email — the user is on an unclaimed anonymous account and
    # we want to nudge them to attach an email so we can reach them
    # for security and breaking-change updates. The action drops them
    # straight into the existing login-link flow.
    if user.claimed_at is None:
        out.append(
            {
                "kind": "claim_email",
                "severity": "info",
                "title": "Claim your account",
                "body": (
                    "Drop your email so we can reach you for security "
                    "and breaking-change updates. We won't spam you."
                ),
                "action": {
                    "label": "Claim",
                    "form": {
                        "endpoint": "/v1/auth/login-link",
                        "fields": ["email"],
                    },
                },
            }
        )

    return {"banners": out}
