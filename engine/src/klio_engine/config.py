"""Application settings — loaded from env, validated by pydantic."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Klio engine settings.

    All env vars are prefixed with KLIO_ to avoid collisions.
    """

    model_config = SettingsConfigDict(env_prefix="KLIO_", env_file=".env", extra="ignore")

    database_url: str
    kms_key_arn: str = "arn:aws:kms:us-east-1:000000000000:key/dev"
    s3_bucket: str = "klio-raw-events-dev"
    aws_region: str = "us-east-1"
    redis_url: str = "redis://localhost:6380/0"
    log_level: str = "INFO"
    embedding_model: str = "text-embedding-3-small"
    embedding_dim: int = 1536
    dedup_cosine_threshold: float = 0.92
    jwt_signing_key: str = "dev-only-secret-replace-me"
