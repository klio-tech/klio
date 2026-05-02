# Klio developer Makefile.
#
# Targets are intended to be safe to re-run; everything is idempotent.
# Postgres + Redis come up via `docker compose up -d`. Ollama is platform-aware:
#   * macOS  → native `brew install ollama` (uses Metal — much faster)
#   * Linux  → docker'd Ollama (opt-in profile, CPU-only by default)

SHELL := /bin/bash
ENGINE_DIR := engine
BRIDGE_DIR := bridge
DOCKER := docker
COMPOSE := $(DOCKER) compose

UNAME_S := $(shell uname -s)

# Default models. Override on the command line:
#   make models-pull EMBED_MODEL=snowflake-arctic-embed2
EMBED_MODEL ?= nomic-embed-text
EXTRACT_MODEL ?= qwen2.5:7b-instruct

.PHONY: help
help:
	@echo "Klio dev targets:"
	@echo "  make up              - Postgres + Redis (Ollama is separate, see below)"
	@echo "  make down            - stop containers (keeps volumes)"
	@echo "  make ollama          - install + start Ollama (native on macOS, docker on Linux)"
	@echo "  make ollama-stop     - stop the Ollama instance for the current platform"
	@echo "  make models-pull     - pull EMBED_MODEL + EXTRACT_MODEL via the running Ollama"
	@echo "  make migrate         - alembic upgrade head against local Postgres"
	@echo "  make engine          - run the engine in foreground (uvicorn)"
	@echo "  make build           - build klio + klio-mcp Go binaries to /tmp"
	@echo "  make test            - engine + bridge test suites"
	@echo "  make test-ollama     - integration tests requiring a live Ollama"
	@echo "  make first-run       - up + ollama + models-pull + migrate + build (idempotent)"
	@echo ""
	@echo "Detected platform: $(UNAME_S)"

.PHONY: up
up:
	$(COMPOSE) up -d postgres redis
	@echo "Waiting for healthchecks..."
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
	  if [ "$$($(COMPOSE) ps --status running --services | wc -l)" = "2" ]; then \
	    echo "Postgres + Redis up."; break; \
	  fi; \
	  sleep 2; \
	done

.PHONY: down
down:
	$(COMPOSE) down

# ----- Platform-aware Ollama lifecycle -------------------------------------

.PHONY: ollama
ifeq ($(UNAME_S),Darwin)
ollama: _ollama-native
else
ollama: _ollama-docker
endif

.PHONY: _ollama-native
_ollama-native:
	@if ! command -v brew >/dev/null; then \
	  echo "Homebrew is required for native Ollama on macOS."; \
	  echo "  Install: /bin/bash -c \"\$$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""; \
	  echo "  …or run: make _ollama-docker  to use the slower docker'd version."; \
	  exit 1; \
	fi
	@if ! command -v ollama >/dev/null; then \
	  echo "Installing Ollama via Homebrew..."; brew install ollama; \
	else \
	  echo "Ollama already installed: $$(ollama --version 2>/dev/null | head -1)"; \
	fi
	@if curl -fsS -m 1 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then \
	  echo "Ollama already running on 127.0.0.1:11434 (Metal accelerated)."; \
	else \
	  echo "Starting Ollama as a service..."; \
	  brew services start ollama; \
	  for i in 1 2 3 4 5 6 7 8 9 10; do \
	    sleep 1; \
	    curl -fsS -m 1 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break; \
	  done; \
	  echo "Ollama up."; \
	fi

.PHONY: _ollama-docker
_ollama-docker:
	$(COMPOSE) --profile docker-ollama up -d ollama
	@echo "Waiting for Ollama..."
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12; do \
	  sleep 2; \
	  curl -fsS -m 1 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break; \
	done
	@echo "Ollama (docker, CPU) up."

.PHONY: ollama-stop
ifeq ($(UNAME_S),Darwin)
ollama-stop:
	-brew services stop ollama
else
ollama-stop:
	-$(COMPOSE) --profile docker-ollama stop ollama
endif

.PHONY: models-pull
models-pull:
	@echo "Pulling embedding model: $(EMBED_MODEL)"
	@if [ "$(UNAME_S)" = "Darwin" ] && command -v ollama >/dev/null; then \
	  ollama pull $(EMBED_MODEL); \
	else \
	  $(DOCKER) exec klio-ollama ollama pull $(EMBED_MODEL); \
	fi
	@echo "Pulling extraction model: $(EXTRACT_MODEL)"
	@if [ "$(UNAME_S)" = "Darwin" ] && command -v ollama >/dev/null; then \
	  ollama pull $(EXTRACT_MODEL); \
	else \
	  $(DOCKER) exec klio-ollama ollama pull $(EXTRACT_MODEL); \
	fi

# Back-compat alias used by the original install prompt.
.PHONY: ollama-pull
ollama-pull: models-pull

# ----- Engine + tests ------------------------------------------------------

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
first-run: up ollama models-pull migrate build
	@echo ""
	@echo "Klio is ready. Next steps:"
	@echo "  make engine        # start the FastAPI engine in foreground"
	@echo "  /tmp/klio init     # provision an account + patch ~/.claude/settings.json"
	@echo "  /tmp/klio daemon & # run the bridge daemon"
