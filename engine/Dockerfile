# Multi-stage Docker image for the Klio engine.
#
# Why containerize: lets `klio init` orchestrate the full stack from a
# single command (Postgres + Redis + Ollama + engine + trust-app), so
# the user never touches Python venvs or pip on their host. The whole
# point of the "10 second onboarding" promise.
#
# Stage 1 (deps): install runtime deps from pyproject.toml. Cached on
# pyproject.toml changes.
#
# Stage 2 (runtime): minimal layer with the source + venv + an
# entrypoint that runs alembic upgrade head before booting uvicorn.
#
# Final image is ~250 MB, predominantly the cryptography + sqlalchemy
# wheels.

FROM python:3.12-slim AS deps

# System deps for asyncpg + cryptography wheels at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential \
        libpq-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only the project metadata first so Docker can cache the
# pip layer when we change source code only.
COPY pyproject.toml ./
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir \
        "fastapi>=0.115" \
        "uvicorn[standard]>=0.32" \
        "sqlalchemy>=2.0" \
        "asyncpg>=0.30" \
        "pgvector>=0.3" \
        "alembic>=1.13" \
        "pydantic[email]>=2.9" \
        "pydantic-settings>=2.5" \
        "litellm>=1.50" \
        "boto3>=1.35" \
        "moto[kms,s3]>=5.0" \
        "cryptography>=43" \
        "structlog>=24" \
        "redis>=5" \
        "python-jose[cryptography]>=3.3" \
        "httpx>=0.27"


FROM python:3.12-slim AS runtime

# Same runtime libs (libpq for asyncpg).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        libpq5 \
 && rm -rf /var/lib/apt/lists/*

# Copy installed packages from deps stage.
COPY --from=deps /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=deps /usr/local/bin /usr/local/bin

WORKDIR /app

# Project source — pyproject.toml + alembic + scripts + the package.
COPY pyproject.toml alembic.ini ./
COPY alembic/ ./alembic/
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Make our package importable.
ENV PYTHONPATH=/app/src

# Persist the dev KMS master key on a volume so engine restarts
# don't lose envelope keys (the same property we built into the
# host-side dev KMS earlier).
ENV KLIO_DEV_KMS_PATH=/var/lib/klio/dev-kms.key
RUN mkdir -p /var/lib/klio

ENV KLIO_HOST=0.0.0.0
ENV KLIO_PORT=8000

EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
