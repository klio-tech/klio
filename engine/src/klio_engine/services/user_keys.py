"""User envelope-key lifecycle."""
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.user import User


class UserKeyService:
    """Manages per-user envelope keys.

    Each user gets one 256-bit envelope key on provisioning. The key is
    wrapped with the KMS master key and stored on the user row. To encrypt
    or decrypt entries, the service unwraps it on demand.
    """

    def __init__(self, kms: KMSClient) -> None:
        self._kms = kms

    async def provision_user_key(self, session: AsyncSession, user: User) -> bytes:
        """Generate, wrap, persist. Returns the plaintext for immediate use."""
        plaintext, wrapped = self._kms.generate_envelope_key()
        user.wrapped_envelope_key = wrapped
        session.add(user)
        await session.flush()
        return plaintext

    async def unwrap_user_key(self, user: User) -> bytes:
        if user.wrapped_envelope_key is None:
            raise ValueError(f"user {user.id} has no envelope key")
        return self._kms.unwrap_envelope_key(user.wrapped_envelope_key)
