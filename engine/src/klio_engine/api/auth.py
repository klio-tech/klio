"""Bearer token verification dependency."""
import os
import time
import uuid
from dataclasses import dataclass

from fastapi import Header, HTTPException, status
from jose import jwt as _jwt
from jose.exceptions import ExpiredSignatureError, JWTError


@dataclass
class RequestContext:
    user_id: uuid.UUID
    agent_id: uuid.UUID
    scopes: list[str]


def require_auth(authorization: str | None = Header(default=None)) -> RequestContext:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Bearer token required")
    token = authorization[len("Bearer ") :]
    secret = os.getenv("KLIO_JWT_SIGNING_KEY")
    if not secret:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "auth not configured"
        )
    try:
        claims = _jwt.decode(
            token, secret, algorithms=["HS256"], audience="klio.tech"
        )
    except ExpiredSignatureError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token expired") from e
    except JWTError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"invalid token: {e}") from e
    return RequestContext(
        user_id=uuid.UUID(claims["sub"]),
        agent_id=uuid.UUID(claims["agent_id"]),
        scopes=claims.get("scopes", []),
    )


def _mint_for_test(
    secret: str,
    user_id: uuid.UUID,
    agent_id: uuid.UUID,
    scopes: list[str],
    ttl: int = 60,
) -> str:
    """Test-only JWT minter."""
    now = int(time.time())
    payload = {
        "sub": str(user_id),
        "agent_id": str(agent_id),
        "scopes": scopes,
        "iat": now,
        "exp": now + ttl,
        "aud": "klio.tech",
        "iss": "test",
    }
    return _jwt.encode(payload, secret, algorithm="HS256")
