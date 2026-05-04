"""Application settings — loaded from env, validated by pydantic."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Klio engine settings.

    All env vars are prefixed with KLIO_ to avoid collisions.

    Embedding architecture is per-space (not global): the
    `embedding_model` setting here is only the *default* used when a new
    space is provisioned without an explicit model. Existing spaces keep
    whatever model was current at their creation time, regardless of how
    this setting later changes. This is required so audit-chain rows
    remain immutable when an operator switches models.
    """

    model_config = SettingsConfigDict(env_prefix="KLIO_", env_file=".env", extra="ignore")

    database_url: str
    kms_key_arn: str = "arn:aws:kms:us-east-1:000000000000:key/dev"
    # When set, the engine uses LocalFileKMSClient with this master key
    # path instead of AWS KMS. Local dev only — see crypto/local_kms.py.
    dev_kms_path: str | None = None
    s3_bucket: str = "klio-raw-events-dev"
    aws_region: str = "us-east-1"
    redis_url: str = "redis://localhost:6380/0"
    log_level: str = "INFO"
    embedding_model: str = "ollama/nomic-embed-text"
    extraction_model: str = "stub"
    ollama_api_base: str = "http://127.0.0.1:11434"
    dedup_cosine_threshold: float = 0.92
    jwt_signing_key: str = "dev-only-secret-replace-me"
    # When set, embedding/extraction LLM calls can be routed through OpenRouter
    # instead of local Ollama. Wired via the npm onboarding flow into the
    # engine container's environment as KLIO_OPENROUTER_API_KEY.
    openrouter_api_key: str | None = None
    # Optional. When set, the engine routes embedding/extraction calls
    # whose model name starts with `custom/` to <custom_base_url>/embeddings
    # (or /chat/completions). Used by the npm onboarding's "Custom"
    # provider option for self-hosted LiteLLM proxies, Azure, vLLM, etc.
    custom_base_url: str | None = None
    custom_api_key: str | None = None
