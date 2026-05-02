# Klio developer Makefile.
#
# Targets are intended to be safe to re-run; everything is idempotent.
# All commands assume `docker compose up -d` has already brought up
# Postgres + Redis + Ollama.

SHELL := /bin/bash
ENGINE_DIR := engine
BRIDGE_DIR := bridge
DOCKER := docker
COMPOSE := $(DOCKER) compose

# Default embedding + extraction models. Override on the command line:
#   make ollama-pull EMBED_MODEL=ollama/snowflake-arctic-embed2
EMBED_MODEL ?= nomic-embed-text
EXTRACT_MODEL ?= qwen2.5:7b-instruct

.PHONY: help
help:
	@echo "Klio dev targets:"
	@echo "  make up              - bring up Postgres + Redis + Ollama"
	@echo "  make down            - stop containers (keeps volumes)"
	@echo "  make ollama-pull     - pull default embedding + extraction models"
	@echo "  make migrate         - alembic upgrade head against local Postgres"
	@echo "  make engine          - run the engine in foreground (uvicorn)"
	@echo "  make build           - build klio + klio-mcp Go binaries to /tmp"
	@echo "  make test            - run engine + bridge test suites"
	@echo "  make test-ollama     - run Ollama-required integration tests"
	@echo "  make first-run       - up + ollama-pull + migrate + build (idempotent)"

.PHONY: up
up:
	$(COMPOSE) up -d
	@echo "Waiting for healthchecks..."
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
	  if $(COMPOSE) ps --format json | python3 -c 'import json,sys; data=[json.loads(l) for l in sys.stdin if l.strip()]; sys.exit(0 if all(d.get("Health") in ("healthy", "") for d in data) else 1)'; then \
	    echo "Healthy."; break; \
	  fi; \
	  sleep 2; \
	done

.PHONY: down
down:
	$(COMPOSE) down

.PHONY: ollama-pull
ollama-pull:
	@echo "Pulling embedding model: $(EMBED_MODEL)"
	$(DOCKER) exec klio-ollama ollama pull $(EMBED_MODEL)
	@echo "Pulling extraction model: $(EXTRACT_MODEL)"
	$(DOCKER) exec klio-ollama ollama pull $(EXTRACT_MODEL)

.PHONY: migrate
migrate:
	cd $(ENGINE_DIR) && \
	  KLIO_DATABASE_URL="postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio" \
	  .venv/bin/alembic upgrade head

.PHONY: engine
engine:
	cd $(ENGINE_DIR) && \
	  KLIO_DATABASE_URL="postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio" \
	  KLIO_JWT_SIGNING_KEY="dev-secret" \
	  KLIO_EMBEDDING_MODEL="ollama/$(EMBED_MODEL)" \
	  KLIO_EXTRACTION_MODEL="ollama/$(EXTRACT_MODEL)" \
	  KLIO_OLLAMA_API_BASE="http://127.0.0.1:11434" \
	  KLIO_REDIS_URL="redis://127.0.0.1:6380/0" \
	  .venv/bin/python scripts/dev_server.py

.PHONY: build
build:
	cd $(BRIDGE_DIR) && go build -o /tmp/klio ./cmd/klio
	cd $(BRIDGE_DIR) && go build -o /tmp/klio-mcp ./cmd/klio-mcp
	@echo "Built: /tmp/klio /tmp/klio-mcp"

.PHONY: test
test:
	cd $(ENGINE_DIR) && \
	  KLIO_DATABASE_URL="postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio" \
	  KLIO_JWT_SIGNING_KEY="test-secret-do-not-use-in-prod" \
	  KLIO_EMBEDDING_MODEL="stub" \
	  KLIO_EXTRACTION_MODEL="stub" \
	  .venv/bin/pytest --tb=short
	cd $(BRIDGE_DIR) && go test ./...

.PHONY: test-ollama
test-ollama:
	cd $(ENGINE_DIR) && \
	  KLIO_DATABASE_URL="postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio" \
	  KLIO_JWT_SIGNING_KEY="test-secret-do-not-use-in-prod" \
	  KLIO_EMBEDDING_MODEL="ollama/$(EMBED_MODEL)" \
	  KLIO_EXTRACTION_MODEL="ollama/$(EXTRACT_MODEL)" \
	  .venv/bin/pytest tests/test_recall_ollama.py tests/test_reembed.py -v --tb=short

.PHONY: first-run
first-run: up ollama-pull migrate build
	@echo ""
	@echo "Klio is ready. Next steps:"
	@echo "  make engine        # start the FastAPI engine in foreground"
	@echo "  /tmp/klio init     # provision an account + patch ~/.claude/settings.json"
	@echo "  /tmp/klio daemon & # run the bridge daemon"
