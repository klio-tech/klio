"""Access-token mint and verify (HS256 JWT)."""
import time
import uuid
from typing import Any

from jose import jwt as _jose_jwt
from jose.exceptions import ExpiredSignatureError, JWTError


class TokenError(Exception):
    """Raised on any token validation failure."""


def mint_access_token(
    *,
    secret: str,
    user_id: uuid.UUID,
    agent_id: uuid.UUID,
    scopes: list[str],
    ttl_seconds: int,
    audience: str = "klio.tech",
) -> str:
    now = int(time.time())
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "agent_id": str(agent_id),
        "scopes": scopes,
        "iat": now,
        "exp": now + ttl_seconds,
        "aud": audience,
        "iss": "coordinator.klio.tech",
    }
    return _jose_jwt.encode(payload, secret, algorithm="HS256")


def verify_access_token(
    *, secret: str, token: str, audience: str = "klio.tech"
) -> dict[str, Any]:
    try:
        return _jose_jwt.decode(token, secret, algorithms=["HS256"], audience=audience)
    except ExpiredSignatureError as e:
        raise TokenError("token expired") from e
    except JWTError as e:
        raise TokenError(f"signature invalid: {e}") from e
