"""Users router — provision, claim, verify, refresh."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.audit.writer import write_audit_event
from klio_engine.auth.magic_link import (
    MagicLinkError,
    issue_magic_link,
    verify_magic_link,
)
from klio_engine.auth.refresh import RefreshTokenError, rotate_refresh_token
from klio_engine.auth.tokens import mint_access_token
from klio_engine.config import Settings
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.dependencies import get_kms, get_session
from klio_engine.schemas.users import (
    ClaimRequest,
    ClaimResponse,
    LoginLinkRequest,
    LoginLinkResponse,
    ProvisionRequest,
    ProvisionResponse,
    RefreshRequest,
    RefreshResponse,
    VerifyRequest,
    VerifyResponse,
)
from klio_engine.services.provisioning import provision_user

router = APIRouter(prefix="/v1/users", tags=["users"])


@router.post(
    "/provision",
    response_model=ProvisionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def provision(
    body: ProvisionRequest,
    session: AsyncSession = Depends(get_session),
    kms: KMSClient = Depends(get_kms),
) -> ProvisionResponse:
    try:
        result = await provision_user(
            session,
            kms=kms,
            agent_kind=body.agent_kind,
            install_id=body.install_id,
            display_name=body.display_name,
            email=str(body.email) if body.email else None,
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    await session.commit()
    return ProvisionResponse(
        user_id=result.user_id,
        agent_id=result.agent_id,
        api_key=result.api_key,
        claimed=result.claimed,
        default_space_id=result.default_space_id,
    )


@router.post("/{user_id}/claim", response_model=ClaimResponse)
async def claim(
    user_id: uuid.UUID,
    body: ClaimRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> ClaimResponse:
    """Initiate the claim flow: email a magic link to the supplied address.

    Anonymous accounts are claimed by associating them with an email and
    sending a magic link. Returning success even when user_id doesn't exist
    avoids leaking which UUIDs are valid.
    """
    plaintext, _ = await issue_magic_link(
        session,
        user_id=user_id,
        ttl_minutes=15,
        ip=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    await session.commit()
    # In dev mode, log the link instead of sending an email.
    import structlog

    structlog.get_logger().info(
        "magic_link_dev_mode",
        to_email=str(body.email),
        link=f"https://klio.tech/verify?token={plaintext}&user_id={user_id}",
        mode="claim",
    )
    return ClaimResponse(magic_link_sent=True)


@router.post("/{user_id}/verify", response_model=VerifyResponse)
async def verify(
    user_id: uuid.UUID,
    body: VerifyRequest,
    session: AsyncSession = Depends(get_session),
) -> VerifyResponse:
    try:
        verified_user = await verify_magic_link(session, plaintext=body.token)
    except MagicLinkError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    if verified_user != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "user_id mismatch")

    settings = Settings()
    access = mint_access_token(
        secret=settings.jwt_signing_key,
        user_id=user_id,
        agent_id=user_id,  # session token uses user_id as agent_id placeholder
        scopes=["session"],
        ttl_seconds=3600,
    )
    session_token = mint_access_token(
        secret=settings.jwt_signing_key,
        user_id=user_id,
        agent_id=user_id,
        scopes=["session"],
        ttl_seconds=30 * 24 * 3600,
    )

    await write_audit_event(
        session,
        user_id=user_id,
        actor_type="user",
        actor_id=user_id,
        action="user.verify",
        target_type="user",
        target_id=user_id,
        metadata={},
    )
    await session.commit()
    return VerifyResponse(
        user_id=user_id, session_token=session_token, access_token=access
    )


auth_router = APIRouter(prefix="/v1/auth", tags=["auth"])


@auth_router.post("/login-link", response_model=LoginLinkResponse)
async def login_link(
    body: LoginLinkRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> LoginLinkResponse:
    """Browser-side magic-link request: looks up the user by email_hash and
    silently issues a link. Always returns ok=True so unknown emails don't
    leak the user database.
    """
    import hashlib

    from sqlalchemy import select

    from klio_engine.models.user import User

    email_hash = hashlib.sha256(str(body.email).encode()).hexdigest()
    # Use .first() rather than .scalar_one_or_none() to be tolerant of
    # multiple rows sharing the same email_hash (legacy data, dev DB, etc).
    # Picking the most-recently-claimed user is the right tiebreaker.
    user = (
        await session.execute(
            select(User)
            .where(User.email_hash == email_hash)
            .order_by(User.claimed_at.desc().nulls_last(), User.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    if user is not None and user.deleted_at is None:
        plaintext, _ = await issue_magic_link(
            session,
            user_id=user.id,
            ttl_minutes=15,
            ip=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
        await session.commit()
        import structlog

        structlog.get_logger().info(
            "login_link_dev_mode",
            to_email=str(body.email),
            link=f"https://klio.tech/verify?token={plaintext}&user_id={user.id}",
            mode="login",
        )
    return LoginLinkResponse(ok=True)


tokens_router = APIRouter(prefix="/v1/tokens", tags=["tokens"])


@tokens_router.post("/refresh", response_model=RefreshResponse)
async def refresh(
    body: RefreshRequest,
    session: AsyncSession = Depends(get_session),
) -> RefreshResponse:
    try:
        new_pt, new_rec = await rotate_refresh_token(session, plaintext=body.refresh_token)
    except RefreshTokenError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(e)) from e

    settings = Settings()
    access = mint_access_token(
        secret=settings.jwt_signing_key,
        user_id=new_rec.user_id,
        agent_id=new_rec.agent_id,
        scopes=["read", "write"],
        ttl_seconds=3600,
    )
    await session.commit()
    return RefreshResponse(
        access_token=access, refresh_token=new_pt, expires_in=3600
    )
