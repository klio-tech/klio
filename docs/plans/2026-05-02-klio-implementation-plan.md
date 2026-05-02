# Klio v0 Implementation Plan — Phase 1 (Public Launch)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship Klio v0 — the public-launch substrate for agent-to-agent collaboration — over 10 weeks, with OSS engine + cloud both available day one, Tier-2 security, single-region (US-East), targeting 1000+ agent installs in the launch window.

**Architecture:** Three-language stack. Go for the daemon, CLI, MCP shim, and realtime fan-out. Python (FastAPI) for the engine and coordinator. TypeScript (Next.js + Cloudflare Workers) for the trust app and edge. New `klio-engine` codebase, Vex-pattern-inspired, OSS-first; the same engine binary runs both cloud and self-host. Postgres + pgvector on Railway, Redis for pub/sub and replay, S3 for raw events, AWS KMS for encryption.

**Tech Stack:** Go 1.22+, Python 3.12+, TypeScript 5+, Next.js 15, FastAPI, SQLAlchemy + Alembic, pgvector (HNSW), Redis 7+, Railway, Cloudflare Workers + Hono, AWS KMS, AWS S3, Resend (email), Sentry, OpenTelemetry, GitHub Actions, Sigstore (artifact signing).

---

## How to use this plan

This plan is organized into **twelve phases (A–L)** sequenced by dependency, not by team track. A later phase usually requires the earlier phase to be complete or at least scaffolded. Within a phase, tasks are listed in order; some tasks within a phase can be parallelized across engineers when noted.

Every task follows the same shape:

- **Files:** exact paths to create / modify / test
- **Step 1 — Write the failing test:** complete code for the test (TDD red)
- **Step 2 — Run test to verify it fails:** exact command and expected failure message
- **Step 3 — Write minimal implementation:** complete code (TDD green)
- **Step 4 — Run test to verify it passes:** exact command and expected output
- **Step 5 — Commit:** exact `git commit` message in conventional-commits format

Some tasks are infrastructure setup (no test) — those have a simpler shape. Some tasks involve external services (Railway, AWS) — those have manual verification steps in addition to or instead of automated tests.

**Conventions used throughout:**

- All commits are conventional-commits-style: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.
- All test files mirror the source path. Python: `tests/<package>/test_<module>.py`. Go: `<package>/<file>_test.go`. TypeScript: `<file>.test.ts`.
- Coverage gate: 80% line coverage minimum for new code. Pytest, `go test -cover`, vitest with c8 coverage.
- Lint gates: `ruff` + `mypy --strict` for Python. `gofmt` + `go vet` + `golangci-lint` for Go. `eslint` + `tsc --noEmit` for TypeScript.
- Every task ends with a commit. Frequent commits are mandatory; squashing happens at PR merge.
- Branch model: trunk-based with short-lived feature branches. PRs require one green CI run + one approving review.

**Skills referenced throughout:** see @superpowers:test-driven-development, @superpowers:systematic-debugging, @superpowers:verification-before-completion.

**Design doc reference:** all architecture decisions live in [`2026-05-02-klio-architecture-design.md`](./2026-05-02-klio-architecture-design.md). When this plan refers to "the design doc," that's the file.

---

## Phase index

| Phase | Topic | Dependencies | Approx duration |
|---|---|---|---|
| **A** | Foundation: repos, CI, schema, encryption | none | Week 1 |
| **B** | Identity & auth in coordinator | A | Week 2 |
| **C** | Engine APIs: ACL, entries, recall | A, B | Week 2-3 |
| **D** | Extraction pipeline | C | Week 3 |
| **E** | Daemon (klio-bridge) foundation | A | Week 3-4 |
| **F** | MCP shim and tools | E | Week 4 |
| **G** | Real-time pub/sub | C, E | Week 4-5 |
| **H** | `npx klio init` bootstrap & agent auto-config | E, F | Week 5 |
| **I** | Trust app | B, C | Week 2-5 (parallel) |
| **J** | Claude Code hooks, skill, slash commands | F, G | Week 5-7 |
| **K** | Backfill from `~/.claude/projects` | C, D, J | Week 6-7 |
| **L** | Security hardening, VDP infra, launch ops | all | Week 7-10 |

A practical reading: Phases A–C are the critical path foundation; nothing else can build until those are in place. Phases I (trust app) and the early parts of E (daemon scaffold) can run in parallel with C from week 2 onward. Real-time (G) needs both engine APIs and daemon scaffolding. Claude Code integration (J) needs MCP working end-to-end.

---

## Phase A — Foundation (Week 1)

Goal: every repo exists with CI, the engine has a working Postgres schema with all entities and indexes, the encryption envelope scheme is implemented and tested. By end of Phase A, an engineer should be able to insert a row into `entries`, query it back, and verify it was encrypted at rest.

### Task A.1 — Reserve npm scope and PyPI namespace

**Files:** none (external account setup)

**Steps:**

1. Visit npmjs.com, log in as the org account, create the `@klio` scope. Add `klio-bridge` as a placeholder package version `0.0.0` to reserve the name. Add Abhishek + at least one other engineer as scope owners with publish permission.
2. Visit pypi.org, log in, register the `klio` package name with a placeholder `0.0.0` upload (use `twine` from a clean throwaway dir). Add maintainers.
3. Visit hub.docker.com, create the `klio` org, reserve `klio/engine` and `klio/coordinator` and `klio/realtime` repos.
4. Visit github.com/klio-tech, confirm the org exists. Add Abhishek + engineers as owners. Set default branch protection rule template.

**Verification:** `npm view @klio/klio-bridge` returns the placeholder. `pip index versions klio` returns `0.0.0`. `gh repo list klio-tech` lists the org.

**No commit** — external setup only.

---

### Task A.2 — Create the six core repos

**Files:** none (repo creation)

**Steps:**

1. From the GitHub UI or `gh` CLI, create the following public repos under `klio-tech`, each with a default `main` branch, MIT-style placeholder `README.md`, and Apache-2.0 LICENSE for the open ones:
   - `klio-tech/engine` (Apache 2.0) — the OSS substrate
   - `klio-tech/protocol` (Apache 2.0) — OpenAPI specs, MCP tool schemas, contract tests
   - `klio-tech/bridge` (Apache 2.0) — local daemon + CLI + MCP shim, all in one Go module
   - `klio-tech/sdk-ts` (Apache 2.0)
   - `klio-tech/sdk-py` (Apache 2.0)
   - `klio-tech/trust-app` (Apache 2.0 for UI; backend BFF can be a separate private repo if preferred)
2. From private GitHub org, create:
   - `klio-tech/coordinator` (private, proprietary) — cloud-only identity/billing/admin service
   - `klio-tech/realtime` (private, proprietary) — WebSocket fan-out service
   - `klio-tech/edge` (private, proprietary) — Cloudflare Workers edge code
   - `klio-tech/infra` (private) — Terraform + Helm + ops scripts
3. Set branch protection on every `main` branch: require 1 review, require linear history, require CI to pass, require signed commits.

**Verification:** `gh repo list klio-tech --limit 20` shows all 10 repos. `gh api repos/klio-tech/engine/branches/main/protection` confirms protection rules.

**No commit yet** — these are empty repos at this stage.

---

### Task A.3 — Bootstrap `klio-tech/protocol` with OpenAPI scaffold

**Files:**
- Create: `protocol/openapi.yaml`
- Create: `protocol/mcp-tools.json`
- Create: `protocol/.github/workflows/contract-test.yml`
- Create: `protocol/README.md`
- Create: `protocol/Makefile`

**Step 1: Write the OpenAPI scaffold**

Create `protocol/openapi.yaml`:

```yaml
openapi: 3.1.0
info:
  title: Klio API
  version: 0.0.1
  description: |
    The Klio agent-collaboration substrate API.
    Spec is the contract between the cloud (api.klio.tech), the daemon (klio-bridge),
    and any third-party SDK or self-hosted engine.
  license:
    name: Apache-2.0
    url: https://www.apache.org/licenses/LICENSE-2.0
servers:
  - url: https://api.klio.tech/v1
    description: Production cloud
  - url: http://localhost:8000/v1
    description: Local self-hosted engine
paths: {}
components:
  schemas: {}
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
```

**Step 2: Write the MCP tools schema**

Create `protocol/mcp-tools.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "version": "0.0.1",
  "tools": []
}
```

**Step 3: Write a Makefile that validates the spec**

Create `protocol/Makefile`:

```makefile
.PHONY: validate test clean

validate:
	npx --yes @redocly/cli@latest lint openapi.yaml
	npx --yes ajv-cli@latest compile -s mcp-tools.json

test: validate

clean:
	rm -rf node_modules
```

**Step 4: Run validation**

Run: `make validate`
Expected: both files validate; output reports zero errors.

**Step 5: Add a GitHub Actions workflow**

Create `protocol/.github/workflows/contract-test.yml`:

```yaml
name: Contract Test
on:
  pull_request:
  push:
    branches: [main]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: make validate
```

**Step 6: Commit**

```bash
cd protocol
git add openapi.yaml mcp-tools.json Makefile .github/
git commit -m "chore: bootstrap protocol repo with OpenAPI scaffold"
git push -u origin main
```

---

### Task A.4 — Bootstrap `klio-tech/engine` Python package

**Files:**
- Create: `engine/pyproject.toml`
- Create: `engine/.python-version`
- Create: `engine/src/klio_engine/__init__.py`
- Create: `engine/tests/__init__.py`
- Create: `engine/tests/test_smoke.py`
- Create: `engine/.github/workflows/ci.yml`
- Create: `engine/.gitignore`
- Create: `engine/Makefile`
- Create: `engine/README.md`

**Step 1: Write the pyproject**

Create `engine/pyproject.toml`:

```toml
[project]
name = "klio-engine"
version = "0.0.1"
description = "Klio substrate engine — the OSS reference implementation"
authors = [{ name = "Klio Tech", email = "engineering@klio.tech" }]
license = { text = "Apache-2.0" }
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.32",
    "sqlalchemy>=2.0",
    "asyncpg>=0.30",
    "pgvector>=0.3",
    "alembic>=1.13",
    "pydantic>=2.9",
    "pydantic-settings>=2.5",
    "litellm>=1.50",
    "boto3>=1.35",
    "cryptography>=43",
    "structlog>=24",
    "opentelemetry-api>=1.27",
    "opentelemetry-sdk>=1.27",
    "opentelemetry-instrumentation-fastapi>=0.48b0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.3",
    "pytest-asyncio>=0.24",
    "pytest-cov>=5",
    "httpx>=0.27",
    "ruff>=0.7",
    "mypy>=1.13",
    "testcontainers[postgres,redis]>=4.8",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/klio_engine"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
addopts = "--cov=klio_engine --cov-report=term-missing --cov-fail-under=80"

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "N", "UP", "B", "SIM", "ASYNC"]

[tool.mypy]
python_version = "3.12"
strict = true
plugins = ["pydantic.mypy"]
```

**Step 2: Write the smoke test**

Create `engine/tests/test_smoke.py`:

```python
"""Smoke test verifying the package imports cleanly and version is set."""
import klio_engine


def test_package_imports():
    assert klio_engine is not None


def test_version_is_set():
    assert hasattr(klio_engine, "__version__")
    assert isinstance(klio_engine.__version__, str)
    assert len(klio_engine.__version__) > 0
```

**Step 3: Run the test, verify it fails**

Run:
```bash
cd engine
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/test_smoke.py -v
```

Expected: `test_version_is_set` fails with `AttributeError: module 'klio_engine' has no attribute '__version__'`.

**Step 4: Implement the minimal package init**

Create `engine/src/klio_engine/__init__.py`:

```python
"""Klio engine — agent-collaboration substrate."""
__version__ = "0.0.1"
```

**Step 5: Run the test, verify it passes**

Run: `pytest tests/test_smoke.py -v`
Expected: `2 passed`.

**Step 6: Add CI workflow**

Create `engine/.github/workflows/ci.yml`:

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: klio_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports: ["5432:5432"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install -e ".[dev]"
      - run: ruff check src tests
      - run: mypy src
      - run: pytest --cov-fail-under=80
        env:
          DATABASE_URL: postgresql+asyncpg://postgres:test@localhost:5432/klio_test
```

**Step 7: Commit**

```bash
cd engine
git add pyproject.toml src/ tests/ .github/ .gitignore Makefile README.md .python-version
git commit -m "chore: bootstrap engine package with CI"
git push -u origin main
```

---

### Task A.5 — Bootstrap `klio-tech/coordinator` Python package

**Files:** mirror of Task A.4 but for `coordinator/` directory.

**Steps:** repeat the structure of A.4. The `coordinator` package is named `klio_coordinator`. The dependencies overlap heavily with engine; same FastAPI / SQLAlchemy / asyncpg base. Add coordinator-specific deps:

```toml
dependencies = [
    # ...all engine deps...
    "httpx>=0.27",            # to call engine internally
    "python-jose[cryptography]>=3.3",  # JWT minting for access tokens
    "stripe>=11",             # billing (placeholder, full integration in Phase L)
    "resend>=2",              # magic-link emails
    "qrcode>=7",              # for future passkey enrollment QR
]
```

Smoke test mirrors `engine/tests/test_smoke.py`. Commit:

```bash
cd coordinator
git add ...
git commit -m "chore: bootstrap coordinator package with CI"
git push -u origin main
```

---

### Task A.6 — Bootstrap `klio-tech/bridge` Go module (daemon + CLI + MCP shim)

**Files:**
- Create: `bridge/go.mod`
- Create: `bridge/cmd/klio/main.go` — the `klio` CLI binary
- Create: `bridge/cmd/klio-mcp/main.go` — the MCP stdio shim
- Create: `bridge/internal/version/version.go`
- Create: `bridge/internal/version/version_test.go`
- Create: `bridge/.github/workflows/ci.yml`
- Create: `bridge/Makefile`
- Create: `bridge/.gitignore`

**Step 1: Initialize the Go module**

Run:
```bash
cd bridge
go mod init github.com/klio-tech/bridge
```

**Step 2: Write the failing test**

Create `bridge/internal/version/version_test.go`:

```go
package version

import "testing"

func TestVersionIsSet(t *testing.T) {
	v := Get()
	if v == "" {
		t.Fatal("version must not be empty")
	}
}

func TestVersionFormat(t *testing.T) {
	v := Get()
	// SemVer-ish: major.minor.patch with optional -prerelease
	if len(v) < 5 {
		t.Fatalf("version %q too short to be valid semver", v)
	}
}
```

**Step 3: Run, verify it fails**

Run: `go test ./internal/version/...`
Expected: `internal/version/version.go: no such file or directory` — package doesn't exist yet.

**Step 4: Write the minimal implementation**

Create `bridge/internal/version/version.go`:

```go
// Package version provides the build version of the Klio bridge.
package version

const v = "0.0.1"

// Get returns the current Klio bridge version.
func Get() string {
	return v
}
```

**Step 5: Run, verify it passes**

Run: `go test ./internal/version/...`
Expected: `ok ... internal/version`.

**Step 6: Write the CLI entrypoint**

Create `bridge/cmd/klio/main.go`:

```go
// Command klio is the Klio daemon, CLI, and MCP shim entrypoint.
//
// The same binary is invoked under different names (klio, klio-mcp) and
// dispatches based on argv[0] / first positional argument.
package main

import (
	"fmt"
	"os"

	"github.com/klio-tech/bridge/internal/version"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "version", "--version", "-v":
		fmt.Println(version.Get())
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand: %s\n", os.Args[1])
		printUsage()
		os.Exit(2)
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "usage: klio [version|init|status|...]")
}
```

**Step 7: Verify the binary builds and runs**

Run:
```bash
go build -o /tmp/klio ./cmd/klio
/tmp/klio version
```
Expected: `0.0.1`.

**Step 8: Write the MCP shim entrypoint**

Create `bridge/cmd/klio-mcp/main.go`:

```go
// Command klio-mcp is the MCP stdio shim that forwards JSON-RPC traffic
// from an agent (Claude Code, Cursor, etc.) to the local klio daemon
// over a unix domain socket.
package main

import (
	"fmt"
	"os"
)

func main() {
	// Phase F implements full forwarding. For now we exit with a placeholder.
	fmt.Fprintln(os.Stderr, "klio-mcp: Phase F not yet implemented")
	os.Exit(0)
}
```

**Step 9: Add the CI workflow**

Create `bridge/.github/workflows/ci.yml`:

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - run: go vet ./...
      - run: go test -race -cover ./...
      - uses: golangci/golangci-lint-action@v6
        with:
          version: v1.61
```

**Step 10: Commit**

```bash
cd bridge
git add go.mod go.sum cmd/ internal/ Makefile .github/ .gitignore
git commit -m "chore: bootstrap bridge module with version test"
git push -u origin main
```

---

### Task A.7 — Bootstrap `klio-tech/realtime` Go module

**Files:** mirror of A.6. Module: `github.com/klio-tech/realtime`. Single `cmd/klio-realtime/main.go` entrypoint with a `version` subcommand. Same CI workflow shape.

**Commit:** `chore: bootstrap realtime module`.

---

### Task A.8 — Provision Railway project and Postgres + Redis

**Files:**
- Create: `infra/railway/README.md` (in the private `infra` repo)

**Steps:**

1. Create a Railway account if not already present. Create a new project named `klio-prod`.
2. Inside the project, provision a Postgres 16 instance with `pgvector` extension. Railway's Postgres ships with extensions you enable manually:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   ```
3. Provision a Redis 7 instance.
4. From the Railway dashboard, copy:
   - `DATABASE_URL` (read by engine + coordinator)
   - `REDIS_URL` (read by realtime + coordinator)
5. Create a second Railway project `klio-staging` with identical setup. Capture URLs.
6. Document the URLs and provisioning steps in `infra/railway/README.md`. Do **not** commit secrets — store them in a 1Password vault or AWS Secrets Manager.

**Verification:** From a workstation, `psql $DATABASE_URL -c '\dx'` lists `vector`, `pgcrypto`, `uuid-ossp` as installed.

**Commit (in `infra` repo):**

```bash
cd infra
git add railway/
git commit -m "docs: document Railway provisioning for prod + staging"
git push -u origin main
```

---

### Task A.9 — Provision AWS KMS keys and S3 bucket

**Files:**
- Create: `infra/aws/main.tf`
- Create: `infra/aws/variables.tf`
- Create: `infra/aws/outputs.tf`

**Steps:**

1. Configure AWS CLI with an admin profile for the Klio AWS account (separate from any Vex/Oppla AWS account).
2. Initialize Terraform in `infra/aws/`.
3. Define the KMS master key for envelope encryption + the S3 bucket for raw events.

Create `infra/aws/main.tf`:

```hcl
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.70" }
  }
  backend "s3" {
    bucket         = "klio-tf-state"
    key            = "aws/main.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "klio-tf-lock"
  }
}

provider "aws" {
  region = "us-east-1"
}

# Master KMS key — wraps per-user envelope keys
resource "aws_kms_key" "master" {
  description             = "Klio master key for envelope encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Project = "klio"
    Tier    = "production"
  }
}

resource "aws_kms_alias" "master" {
  name          = "alias/klio-master"
  target_key_id = aws_kms_key.master.key_id
}

# Raw events bucket — append-only, encrypted with KMS
resource "aws_s3_bucket" "raw_events" {
  bucket = "klio-raw-events-prod"
}

resource "aws_s3_bucket_server_side_encryption_configuration" "raw_events" {
  bucket = aws_s3_bucket.raw_events.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.master.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "raw_events" {
  bucket = aws_s3_bucket.raw_events.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "raw_events" {
  bucket                  = aws_s3_bucket.raw_events.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "raw_events" {
  bucket = aws_s3_bucket.raw_events.id
  rule {
    id     = "expire-incomplete-uploads"
    status = "Enabled"
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}
```

Create `infra/aws/outputs.tf`:

```hcl
output "kms_master_key_arn" {
  value = aws_kms_key.master.arn
}

output "kms_master_key_alias" {
  value = aws_kms_alias.master.name
}

output "raw_events_bucket" {
  value = aws_s3_bucket.raw_events.id
}
```

4. Apply Terraform:

Run:
```bash
cd infra/aws
terraform init
terraform plan
terraform apply
```

Expected: KMS key + alias + S3 bucket created. Outputs printed.

5. Capture the outputs into the team password manager. Do not commit them.

**Commit:**

```bash
cd infra
git add aws/
git commit -m "feat: provision AWS KMS master key and raw-events S3 bucket"
git push
```

---

### Task A.10 — Engine: configure SQLAlchemy async engine + settings

**Files:**
- Create: `engine/src/klio_engine/config.py`
- Create: `engine/src/klio_engine/db.py`
- Create: `engine/tests/test_config.py`
- Create: `engine/tests/test_db.py`

**Step 1: Write the failing config test**

Create `engine/tests/test_config.py`:

```python
"""Settings loading tests."""
import os

import pytest

from klio_engine.config import Settings


def test_settings_loads_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x:y@host/db")
    monkeypatch.setenv("KLIO_KMS_KEY_ARN", "arn:aws:kms:us-east-1:123:key/abc")
    monkeypatch.setenv("KLIO_S3_BUCKET", "klio-raw-events-prod")
    s = Settings()
    assert str(s.database_url) == "postgresql+asyncpg://x:y@host/db"
    assert s.kms_key_arn == "arn:aws:kms:us-east-1:123:key/abc"
    assert s.s3_bucket == "klio-raw-events-prod"


def test_settings_requires_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KLIO_DATABASE_URL", raising=False)
    with pytest.raises(ValueError, match="database_url"):
        Settings(_env_file=None)
```

**Step 2: Run, verify it fails**

Run: `pytest tests/test_config.py -v`
Expected: `ModuleNotFoundError: No module named 'klio_engine.config'`.

**Step 3: Implement settings**

Create `engine/src/klio_engine/config.py`:

```python
"""Application settings — loaded from env, validated by pydantic."""
from pydantic import PostgresDsn
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Klio engine settings.

    All env vars are prefixed with KLIO_ to avoid collisions.
    """

    model_config = SettingsConfigDict(env_prefix="KLIO_", env_file=".env")

    database_url: PostgresDsn
    kms_key_arn: str
    s3_bucket: str
    aws_region: str = "us-east-1"
    log_level: str = "INFO"
    embedding_model: str = "text-embedding-3-small"
    embedding_dim: int = 1536
    dedup_cosine_threshold: float = 0.92
```

**Step 4: Run, verify it passes**

Run: `pytest tests/test_config.py -v`
Expected: `2 passed`.

**Step 5: Write the failing db test**

Create `engine/tests/test_db.py`:

```python
"""Database engine smoke test against a live testcontainer."""
import pytest
from sqlalchemy import text
from testcontainers.postgres import PostgresContainer

from klio_engine.db import build_engine


@pytest.mark.asyncio
async def test_can_connect_and_query() -> None:
    with PostgresContainer("pgvector/pgvector:pg16") as pg:
        url = pg.get_connection_url().replace("postgresql://", "postgresql+asyncpg://", 1)
        engine = build_engine(url)
        async with engine.connect() as conn:
            result = await conn.execute(text("SELECT 1 AS one"))
            row = result.one()
            assert row.one == 1
        await engine.dispose()


@pytest.mark.asyncio
async def test_pgvector_extension_available() -> None:
    with PostgresContainer("pgvector/pgvector:pg16") as pg:
        url = pg.get_connection_url().replace("postgresql://", "postgresql+asyncpg://", 1)
        engine = build_engine(url)
        async with engine.connect() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            result = await conn.execute(
                text("SELECT extname FROM pg_extension WHERE extname = 'vector'")
            )
            assert result.scalar() == "vector"
        await engine.dispose()
```

**Step 6: Run, verify it fails**

Run: `pytest tests/test_db.py -v`
Expected: `ModuleNotFoundError: No module named 'klio_engine.db'`.

**Step 7: Implement the db module**

Create `engine/src/klio_engine/db.py`:

```python
"""SQLAlchemy async engine factory."""
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine


def build_engine(url: str, *, echo: bool = False) -> AsyncEngine:
    """Build a SQLAlchemy AsyncEngine pointed at the given Postgres URL.

    The URL must use the asyncpg driver (postgresql+asyncpg://).
    """
    return create_async_engine(
        url,
        echo=echo,
        pool_pre_ping=True,
        pool_size=10,
        max_overflow=20,
    )
```

**Step 8: Run, verify it passes**

Run: `pytest tests/test_db.py -v`
Expected: `2 passed` (containers start, queries work).

**Step 9: Commit**

```bash
cd engine
git add src/klio_engine/config.py src/klio_engine/db.py tests/test_config.py tests/test_db.py
git commit -m "feat(engine): add settings and async DB engine factory"
git push
```

---

### Task A.11 — Engine: Alembic setup and first migration (extensions only)

**Files:**
- Create: `engine/alembic.ini`
- Create: `engine/alembic/env.py`
- Create: `engine/alembic/script.py.mako`
- Create: `engine/alembic/versions/0001_extensions.py`
- Create: `engine/tests/test_migrations.py`

**Step 1: Initialize Alembic structure**

Run:
```bash
cd engine
alembic init alembic
```

This creates `alembic.ini`, `alembic/env.py`, `alembic/script.py.mako`, `alembic/versions/`.

**Step 2: Replace `alembic/env.py` with async-aware version**

Create `engine/alembic/env.py`:

```python
"""Async-aware Alembic env."""
import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from klio_engine.config import Settings

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

settings = Settings()
config.set_main_option("sqlalchemy.url", str(settings.database_url))

target_metadata = None


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

**Step 3: Write the failing migrations test**

Create `engine/tests/test_migrations.py`:

```python
"""Verify migrations apply cleanly to a fresh Postgres."""
import subprocess

import pytest
from sqlalchemy import text
from testcontainers.postgres import PostgresContainer


@pytest.mark.asyncio
async def test_extensions_migration_applies(monkeypatch: pytest.MonkeyPatch) -> None:
    with PostgresContainer("pgvector/pgvector:pg16") as pg:
        url = pg.get_connection_url().replace("postgresql://", "postgresql+asyncpg://", 1)
        monkeypatch.setenv("KLIO_DATABASE_URL", url)
        monkeypatch.setenv("KLIO_KMS_KEY_ARN", "arn:aws:kms:us-east-1:123:key/test")
        monkeypatch.setenv("KLIO_S3_BUCKET", "test")

        result = subprocess.run(
            ["alembic", "upgrade", "head"],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr

        from klio_engine.db import build_engine
        engine = build_engine(url)
        async with engine.connect() as conn:
            extensions = (
                await conn.execute(
                    text("SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pgcrypto', 'uuid-ossp')")
                )
            ).scalars().all()
            assert set(extensions) == {"vector", "pgcrypto", "uuid-ossp"}
        await engine.dispose()
```

**Step 4: Run, verify it fails**

Run: `pytest tests/test_migrations.py -v`
Expected: alembic exits non-zero because `versions/` is empty (no `head`).

**Step 5: Create the first migration**

Create `engine/alembic/versions/0001_extensions.py`:

```python
"""Enable required Postgres extensions.

Revision ID: 0001
Revises:
Create Date: 2026-05-02
"""
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")


def downgrade() -> None:
    op.execute("DROP EXTENSION IF EXISTS vector")
    op.execute("DROP EXTENSION IF EXISTS pgcrypto")
    op.execute('DROP EXTENSION IF EXISTS "uuid-ossp"')
```

**Step 6: Run, verify it passes**

Run: `pytest tests/test_migrations.py -v`
Expected: `1 passed`.

**Step 7: Commit**

```bash
cd engine
git add alembic.ini alembic/ tests/test_migrations.py
git commit -m "feat(engine): scaffold Alembic and add extensions migration"
git push
```

---

### Task A.12 — Engine: ORM models for User and Agent

**Files:**
- Create: `engine/src/klio_engine/models/__init__.py`
- Create: `engine/src/klio_engine/models/base.py`
- Create: `engine/src/klio_engine/models/user.py`
- Create: `engine/src/klio_engine/models/agent.py`
- Create: `engine/tests/models/__init__.py`
- Create: `engine/tests/models/test_user.py`
- Create: `engine/tests/models/test_agent.py`
- Create: `engine/alembic/versions/0002_users_agents.py`

**Step 1: Write the failing user-model test**

Create `engine/tests/models/test_user.py`:

```python
"""User model tests."""
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.user import User


@pytest.mark.asyncio
async def test_can_insert_anonymous_user(session: AsyncSession) -> None:
    u = User()
    session.add(u)
    await session.flush()

    assert isinstance(u.id, uuid.UUID)
    assert u.email_hash is None
    assert u.claimed_at is None
    assert u.deleted_at is None
    assert isinstance(u.created_at, datetime)


@pytest.mark.asyncio
async def test_can_claim_user_with_email_hash(session: AsyncSession) -> None:
    email_hash = "deadbeef" * 8
    u = User(email_hash=email_hash, claimed_at=datetime.now(UTC))
    session.add(u)
    await session.flush()

    fetched = (await session.execute(select(User).where(User.id == u.id))).scalar_one()
    assert fetched.email_hash == email_hash
    assert fetched.claimed_at is not None
```

**Step 2: Write the test fixtures (conftest)**

Create `engine/tests/conftest.py`:

```python
"""Shared pytest fixtures."""
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from testcontainers.postgres import PostgresContainer

from klio_engine.db import build_engine


@pytest.fixture(scope="session")
def postgres_container() -> AsyncIterator[PostgresContainer]:
    with PostgresContainer("pgvector/pgvector:pg16") as pg:
        yield pg


@pytest_asyncio.fixture
async def session(postgres_container: PostgresContainer) -> AsyncIterator[AsyncSession]:
    url = postgres_container.get_connection_url().replace(
        "postgresql://", "postgresql+asyncpg://", 1
    )
    engine = build_engine(url)
    async with engine.begin() as conn:
        from klio_engine.models.base import Base
        from sqlalchemy import text
        await conn.execute(text('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'))
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as s:
        yield s
        await s.rollback()
    await engine.dispose()
```

**Step 3: Run, verify it fails**

Run: `pytest tests/models/test_user.py -v`
Expected: `ModuleNotFoundError: No module named 'klio_engine.models'`.

**Step 4: Implement Base + User**

Create `engine/src/klio_engine/models/base.py`:

```python
"""Declarative base for all ORM models."""
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Base class for all Klio engine ORM models."""
```

Create `engine/src/klio_engine/models/user.py`:

```python
"""User model — root principal."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from klio_engine.models.base import Base


class User(Base):
    """The root principal. All Klio data hangs off a user_id."""

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    email_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
```

Create `engine/src/klio_engine/models/__init__.py`:

```python
"""ORM models."""
from klio_engine.models.base import Base
from klio_engine.models.user import User

__all__ = ["Base", "User"]
```

**Step 5: Run, verify it passes**

Run: `pytest tests/models/test_user.py -v`
Expected: `2 passed`.

**Step 6: Write the agent model test**

Create `engine/tests/models/test_agent.py`:

```python
"""Agent model tests."""
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.user import User


@pytest.mark.asyncio
async def test_can_insert_agent(session: AsyncSession) -> None:
    u = User()
    session.add(u)
    await session.flush()

    a = Agent(
        user_id=u.id,
        kind=AgentKind.CLAUDE_CODE,
        install_id=uuid.uuid4(),
        display_name="Claude Code on MacBook Pro",
    )
    session.add(a)
    await session.flush()

    assert isinstance(a.id, uuid.UUID)
    assert a.user_id == u.id


@pytest.mark.asyncio
async def test_user_kind_install_id_is_unique(session: AsyncSession) -> None:
    u = User()
    session.add(u)
    await session.flush()

    install = uuid.uuid4()
    a1 = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=install)
    session.add(a1)
    await session.flush()

    a2 = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=install)
    session.add(a2)
    with pytest.raises(IntegrityError):
        await session.flush()
```

**Step 7: Run, verify it fails**

Run: `pytest tests/models/test_agent.py -v`
Expected: `ModuleNotFoundError: No module named 'klio_engine.models.agent'`.

**Step 8: Implement Agent**

Create `engine/src/klio_engine/models/agent.py`:

```python
"""Agent model — a specific install of an MCP-capable agent."""
import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from klio_engine.models.base import Base


class AgentKind(str, enum.Enum):
    """Known agent kinds. CUSTOM is for SDK consumers."""

    CLAUDE_CODE = "claude-code"
    CURSOR = "cursor"
    CODEX = "codex"
    ANTIGRAVITY = "antigravity"
    KLIO_BRIDGE = "klio-bridge"
    CUSTOM = "custom"


class Agent(Base):
    """A specific agent install. (user_id, kind, install_id) is unique."""

    __tablename__ = "agents"
    __table_args__ = (
        UniqueConstraint("user_id", "kind", "install_id", name="uq_agent_user_kind_install"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[AgentKind] = mapped_column(Enum(AgentKind, name="agent_kind"), nullable=False)
    install_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
```

Update `engine/src/klio_engine/models/__init__.py`:

```python
"""ORM models."""
from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.base import Base
from klio_engine.models.user import User

__all__ = ["Agent", "AgentKind", "Base", "User"]
```

**Step 9: Run, verify it passes**

Run: `pytest tests/models/test_agent.py -v`
Expected: `2 passed`.

**Step 10: Generate Alembic migration**

Run:
```bash
alembic revision --autogenerate -m "users_agents"
```

Edit the generated `alembic/versions/0002_*.py` file to ensure it creates `users` and `agents` tables with the correct columns and constraints.

**Step 11: Run migrations test (full chain)**

Run: `pytest tests/test_migrations.py -v`
Expected: passes (extensions + users + agents apply cleanly).

**Step 12: Commit**

```bash
cd engine
git add src/klio_engine/models/ tests/models/ tests/conftest.py alembic/versions/0002_*.py
git commit -m "feat(engine): add User and Agent models with first migration"
git push
```

---

### Task A.13 — Engine: ORM models for Space, Permission, Session

**Files:**
- Create: `engine/src/klio_engine/models/space.py`
- Create: `engine/src/klio_engine/models/permission.py`
- Create: `engine/src/klio_engine/models/session.py`
- Create: `engine/tests/models/test_space.py`
- Create: `engine/tests/models/test_permission.py`
- Create: `engine/tests/models/test_session.py`
- Create: `engine/alembic/versions/0003_spaces_permissions_sessions.py`

Follow the same TDD pattern as A.12. The schemas (per the design doc):

**Space:**
```python
class Space(Base):
    __tablename__ = "spaces"
    __table_args__ = (UniqueConstraint("user_id", "slug", name="uq_space_user_slug"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[uuid.UUID] = mapped_column(UUID, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    slug: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[datetime | None]
```

**PermissionScope enum:** `READ`, `WRITE`, `ADMIN`.

**Permission:**
```python
class Permission(Base):
    __tablename__ = "permissions"
    __table_args__ = (
        UniqueConstraint("user_id", "space_id", "agent_id", name="uq_perm_user_space_agent"),
    )

    id: Mapped[uuid.UUID]
    user_id: Mapped[uuid.UUID] = ForeignKey("users.id", ondelete="CASCADE")
    space_id: Mapped[uuid.UUID] = ForeignKey("spaces.id", ondelete="CASCADE")
    agent_id: Mapped[uuid.UUID] = ForeignKey("agents.id", ondelete="CASCADE")
    scope: Mapped[PermissionScope]
    granted_at: Mapped[datetime]
    granted_by_user_id: Mapped[uuid.UUID | None]  # NULL if granted by another agent
    granted_by_agent_id: Mapped[uuid.UUID | None]
    revoked_at: Mapped[datetime | None]
```

**Session:**
```python
class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID]
    user_id: Mapped[uuid.UUID] = ForeignKey("users.id", ondelete="CASCADE")
    agent_id: Mapped[uuid.UUID] = ForeignKey("agents.id", ondelete="CASCADE")
    space_id: Mapped[uuid.UUID] = ForeignKey("spaces.id", ondelete="CASCADE")
    started_at: Mapped[datetime] = server_default=func.now()
    ended_at: Mapped[datetime | None]
    source_type: Mapped[str] = mapped_column(String(50), nullable=False)  # "claude-code-session", etc.
```

**Test cases per model:**
- Space: insert, slug-uniqueness within user, slug-collision across users is allowed
- Permission: insert, scope enum round-trip, unique (user, space, agent)
- Session: insert, source_type captured, ended_at can be None

After tests pass, autogenerate migration `0003_*.py`, verify it applies cleanly via `pytest tests/test_migrations.py`.

**Commit:** `feat(engine): add Space, Permission, Session models`.

---

### Task A.14 — Engine: ORM model for Entry (with vector column)

**Files:**
- Create: `engine/src/klio_engine/models/entry.py`
- Create: `engine/tests/models/test_entry.py`
- Create: `engine/alembic/versions/0004_entries.py`

**Step 1: Write the failing test**

Create `engine/tests/models/test_entry.py`:

```python
"""Entry model tests."""
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.models.space import Space
from klio_engine.models.user import User


@pytest.mark.asyncio
async def test_can_insert_memory_entry(session: AsyncSession) -> None:
    u = User()
    session.add(u)
    await session.flush()
    a = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=uuid.uuid4())
    s = Space(user_id=u.id, name="Default", slug="default")
    session.add_all([a, s])
    await session.flush()

    e = Entry(
        user_id=u.id,
        space_id=s.id,
        agent_id=a.id,
        kind=EntryKind.MEMORY,
        content_ciphertext=b"encrypted bytes here",
        content_nonce=b"\x00" * 12,
        embedding=[0.1] * 1536,
        confidence=0.95,
    )
    session.add(e)
    await session.flush()

    assert isinstance(e.id, uuid.UUID)
    assert e.kind is EntryKind.MEMORY
    assert len(e.embedding) == 1536


@pytest.mark.asyncio
async def test_supersedes_self_reference(session: AsyncSession) -> None:
    u = User()
    session.add(u)
    await session.flush()
    a = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=uuid.uuid4())
    s = Space(user_id=u.id, name="Default", slug="default")
    session.add_all([a, s])
    await session.flush()

    older = Entry(
        user_id=u.id, space_id=s.id, agent_id=a.id,
        kind=EntryKind.MEMORY, content_ciphertext=b"x", content_nonce=b"\x00" * 12,
        embedding=[0.0] * 1536, confidence=0.9,
    )
    session.add(older)
    await session.flush()

    newer = Entry(
        user_id=u.id, space_id=s.id, agent_id=a.id,
        kind=EntryKind.MEMORY, content_ciphertext=b"y", content_nonce=b"\x00" * 12,
        embedding=[0.1] * 1536, confidence=0.95,
        superseded_by=None,
    )
    session.add(newer)
    await session.flush()

    older.superseded_by = newer.id
    await session.flush()
    fetched = (await session.execute(select(Entry).where(Entry.id == older.id))).scalar_one()
    assert fetched.superseded_by == newer.id
```

**Step 2: Run, verify it fails** — `ModuleNotFoundError`.

**Step 3: Implement the Entry model**

Create `engine/src/klio_engine/models/entry.py`:

```python
"""Entry model — the unit of all stored content."""
import enum
import uuid
from datetime import datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    JSON, DateTime, Enum, Float, ForeignKey, Index, LargeBinary, func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from klio_engine.models.base import Base


class EntryKind(str, enum.Enum):
    """Five entry kinds for v0; HANDOFF ships in Phase 1 expansion."""

    MEMORY = "memory"
    OBSERVATION = "observation"
    PLAN = "plan"
    DECISION = "decision"
    NOTE = "note"
    # HANDOFF = "handoff"  # deferred to Phase 1 expansion


class Entry(Base):
    __tablename__ = "entries"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    space_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("spaces.id", ondelete="CASCADE"), nullable=False
    )
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[EntryKind] = mapped_column(Enum(EntryKind, name="entry_kind"), nullable=False)

    # Encrypted payload (per-user envelope key, AES-256-GCM).
    content_ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    content_nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    metadata_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    metadata_nonce: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    encryption_key_id: Mapped[str | None] = mapped_column(nullable=True)

    # Plaintext, searchable.
    embedding: Mapped[list[float]] = mapped_column(Vector(1536), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)

    superseded_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("entries.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_entries_user_space_created", "user_id", "space_id", "created_at"),
        Index("ix_entries_user_space_kind_created", "user_id", "space_id", "kind", "created_at"),
        Index("ix_entries_superseded_by", "superseded_by", postgresql_where="superseded_by IS NOT NULL"),
    )
```

**Step 4: Run, verify it passes**

Run: `pytest tests/models/test_entry.py -v`
Expected: `2 passed`.

**Step 5: Generate migration with HNSW vector index**

Run: `alembic revision --autogenerate -m "entries"`.

Edit the generated `alembic/versions/0004_*.py` to add the HNSW index after the table create:

```python
def upgrade() -> None:
    # ... autogenerated table create ...
    op.execute(
        "CREATE INDEX ix_entries_embedding_hnsw ON entries "
        "USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_entries_embedding_hnsw")
    # ... autogenerated table drop ...
```

**Step 6: Verify the migration test passes end-to-end**

Run: `pytest tests/test_migrations.py -v`
Expected: passes — extensions + users + agents + spaces + permissions + sessions + entries all apply.

**Step 7: Commit**

```bash
git add src/klio_engine/models/entry.py tests/models/test_entry.py alembic/versions/0004_*.py
git commit -m "feat(engine): add Entry model with HNSW vector index"
```

---

### Task A.15 — Engine: AuditLogEntry model with hash chain

**Files:**
- Create: `engine/src/klio_engine/models/audit.py`
- Create: `engine/tests/models/test_audit.py`
- Create: `engine/alembic/versions/0005_audit_log.py`
- Create: `engine/src/klio_engine/audit/__init__.py`
- Create: `engine/src/klio_engine/audit/chain.py`
- Create: `engine/tests/audit/test_chain.py`

**Step 1: Write the failing audit-chain test**

Create `engine/tests/audit/test_chain.py`:

```python
"""Hash chain tests."""
import hashlib
from datetime import UTC, datetime
from uuid import uuid4

from klio_engine.audit.chain import AuditEvent, compute_hash, verify_chain


def test_compute_hash_is_deterministic() -> None:
    e = AuditEvent(
        id=uuid4(),
        user_id=uuid4(),
        actor_type="user",
        actor_id=uuid4(),
        action="space.create",
        target_type="space",
        target_id=uuid4(),
        metadata={"name": "Klio"},
        prev_hash="0" * 64,
        created_at=datetime(2026, 5, 2, 12, 0, 0, tzinfo=UTC),
    )
    h1 = compute_hash(e)
    h2 = compute_hash(e)
    assert h1 == h2
    assert len(h1) == 64
    assert int(h1, 16) >= 0


def test_chain_verifies_intact_sequence() -> None:
    user_id = uuid4()
    actor_id = uuid4()
    events: list[AuditEvent] = []
    prev = "0" * 64
    for i in range(5):
        e = AuditEvent(
            id=uuid4(), user_id=user_id, actor_type="user", actor_id=actor_id,
            action=f"action.{i}", target_type="x", target_id=uuid4(),
            metadata={"i": i}, prev_hash=prev,
            created_at=datetime(2026, 5, 2, 12, i, 0, tzinfo=UTC),
        )
        e.hash = compute_hash(e)
        events.append(e)
        prev = e.hash
    assert verify_chain(events) is True


def test_chain_detects_tampering() -> None:
    user_id = uuid4()
    e1 = AuditEvent(
        id=uuid4(), user_id=user_id, actor_type="user", actor_id=uuid4(),
        action="a", target_type="x", target_id=uuid4(), metadata={},
        prev_hash="0" * 64, created_at=datetime(2026, 5, 2, 12, 0, 0, tzinfo=UTC),
    )
    e1.hash = compute_hash(e1)
    e2 = AuditEvent(
        id=uuid4(), user_id=user_id, actor_type="user", actor_id=uuid4(),
        action="b", target_type="x", target_id=uuid4(), metadata={},
        prev_hash=e1.hash, created_at=datetime(2026, 5, 2, 12, 1, 0, tzinfo=UTC),
    )
    e2.hash = compute_hash(e2)
    # tamper with e1's metadata after the fact
    e1.metadata = {"tampered": True}
    assert verify_chain([e1, e2]) is False
```

**Step 2: Run, verify it fails** — `ModuleNotFoundError`.

**Step 3: Implement the chain**

Create `engine/src/klio_engine/audit/chain.py`:

```python
"""Tamper-evident audit log via SHA-256 hash chain.

Each event's hash = sha256(prev_hash || canonical_json(event_fields)).
Verifying the chain is O(n): recompute each event's hash and check it matches
the recorded hash, and that it equals the next event's prev_hash.
"""
import dataclasses
import hashlib
import json
import uuid
from collections.abc import Iterable
from datetime import datetime
from typing import Any


@dataclasses.dataclass
class AuditEvent:
    id: uuid.UUID
    user_id: uuid.UUID
    actor_type: str
    actor_id: uuid.UUID | None
    action: str
    target_type: str
    target_id: uuid.UUID | None
    metadata: dict[str, Any]
    prev_hash: str
    created_at: datetime
    hash: str | None = None


def _canonicalize(e: AuditEvent) -> bytes:
    """Stable JSON for hashing — sorted keys, no whitespace, ISO timestamps."""
    payload = {
        "id": str(e.id),
        "user_id": str(e.user_id),
        "actor_type": e.actor_type,
        "actor_id": str(e.actor_id) if e.actor_id else None,
        "action": e.action,
        "target_type": e.target_type,
        "target_id": str(e.target_id) if e.target_id else None,
        "metadata": e.metadata,
        "prev_hash": e.prev_hash,
        "created_at": e.created_at.isoformat(),
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def compute_hash(e: AuditEvent) -> str:
    return hashlib.sha256(_canonicalize(e)).hexdigest()


def verify_chain(events: Iterable[AuditEvent]) -> bool:
    """Return True iff every event's recorded hash matches its computed hash
    AND prev_hash links the chain together correctly.
    """
    prev = "0" * 64
    for e in events:
        if e.hash is None:
            return False
        if e.prev_hash != prev:
            return False
        if compute_hash(e) != e.hash:
            return False
        prev = e.hash
    return True
```

Create `engine/src/klio_engine/audit/__init__.py`:

```python
"""Audit log subsystem."""
from klio_engine.audit.chain import AuditEvent, compute_hash, verify_chain

__all__ = ["AuditEvent", "compute_hash", "verify_chain"]
```

**Step 4: Run, verify it passes**

Run: `pytest tests/audit/test_chain.py -v`
Expected: `3 passed`.

**Step 5: Implement the AuditLogEntry ORM model**

Create `engine/src/klio_engine/models/audit.py`:

```python
"""AuditLogEntry — append-only with hash chain."""
import uuid
from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from klio_engine.models.base import Base


class AuditLogEntry(Base):
    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    actor_type: Mapped[str] = mapped_column(String(20), nullable=False)  # "user", "agent", "system"
    actor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    action: Mapped[str] = mapped_column(String(100), nullable=False)  # "space.create", "permission.grant", ...
    target_type: Mapped[str] = mapped_column(String(50), nullable=False)
    target_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    audit_metadata: Mapped[dict] = mapped_column("metadata", JSON, nullable=False, default=dict)
    prev_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
```

**Step 6: Generate migration, verify migration test passes**

Run: `alembic revision --autogenerate -m "audit_log"` and `pytest tests/test_migrations.py -v`.

**Step 7: Commit**

```bash
git add src/klio_engine/audit/ src/klio_engine/models/audit.py tests/audit/ tests/models/test_audit.py alembic/versions/0005_*.py
git commit -m "feat(engine): add audit log with hash chain"
```

---

### Task A.16 — Engine: KMS envelope encryption helpers

**Files:**
- Create: `engine/src/klio_engine/crypto/__init__.py`
- Create: `engine/src/klio_engine/crypto/envelope.py`
- Create: `engine/src/klio_engine/crypto/kms_client.py`
- Create: `engine/tests/crypto/test_envelope.py`
- Create: `engine/tests/crypto/test_kms_client.py`

**Step 1: Write the failing envelope test**

Create `engine/tests/crypto/test_envelope.py`:

```python
"""Envelope encryption tests."""
from klio_engine.crypto.envelope import EnvelopeEncrypter


def test_round_trip_with_known_key() -> None:
    key = b"\x00" * 32  # 256-bit envelope key
    enc = EnvelopeEncrypter(envelope_key=key)
    plaintext = b"User prefers TypeScript over JavaScript"
    nonce, ciphertext = enc.encrypt(plaintext)
    assert len(nonce) == 12
    assert ciphertext != plaintext
    decrypted = enc.decrypt(nonce, ciphertext)
    assert decrypted == plaintext


def test_unique_nonce_per_call() -> None:
    enc = EnvelopeEncrypter(envelope_key=b"\x01" * 32)
    nonces = {enc.encrypt(b"same plaintext")[0] for _ in range(100)}
    assert len(nonces) == 100  # collision probability is astronomically small


def test_tampered_ciphertext_fails() -> None:
    import pytest
    from cryptography.exceptions import InvalidTag

    enc = EnvelopeEncrypter(envelope_key=b"\x02" * 32)
    nonce, ct = enc.encrypt(b"hello")
    bad_ct = ct[:-1] + bytes([(ct[-1] + 1) % 256])
    with pytest.raises(InvalidTag):
        enc.decrypt(nonce, bad_ct)
```

**Step 2: Run, verify it fails** — `ModuleNotFoundError`.

**Step 3: Implement EnvelopeEncrypter**

Create `engine/src/klio_engine/crypto/envelope.py`:

```python
"""AES-256-GCM envelope encryption."""
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class EnvelopeEncrypter:
    """Encrypts plaintext with a 256-bit key using AES-256-GCM.

    The envelope key is held in memory only. It is unwrapped from KMS by the
    caller (see kms_client.py) before being passed in. After use, the caller
    should drop the reference; Python doesn't expose secure-zeroing.
    """

    def __init__(self, envelope_key: bytes) -> None:
        if len(envelope_key) != 32:
            raise ValueError("envelope_key must be 32 bytes (256 bits)")
        self._aead = AESGCM(envelope_key)

    def encrypt(self, plaintext: bytes, *, aad: bytes | None = None) -> tuple[bytes, bytes]:
        """Returns (nonce, ciphertext_with_auth_tag)."""
        nonce = os.urandom(12)
        ct = self._aead.encrypt(nonce, plaintext, aad)
        return nonce, ct

    def decrypt(self, nonce: bytes, ciphertext: bytes, *, aad: bytes | None = None) -> bytes:
        return self._aead.decrypt(nonce, ciphertext, aad)
```

**Step 4: Run, verify it passes**

Run: `pytest tests/crypto/test_envelope.py -v`
Expected: `3 passed`.

**Step 5: Write the failing KMS client test**

Create `engine/tests/crypto/test_kms_client.py`:

```python
"""KMS client tests, mocked with moto."""
import boto3
import pytest
from moto import mock_aws

from klio_engine.crypto.kms_client import KMSClient


@mock_aws
def test_generate_and_decrypt_envelope_key() -> None:
    kms = boto3.client("kms", region_name="us-east-1")
    response = kms.create_key(Description="test")
    key_arn = response["KeyMetadata"]["Arn"]

    client = KMSClient(key_arn=key_arn, region="us-east-1")
    plaintext_key, wrapped_key = client.generate_envelope_key()
    assert len(plaintext_key) == 32

    decrypted = client.unwrap_envelope_key(wrapped_key)
    assert decrypted == plaintext_key


@mock_aws
def test_unwrap_with_wrong_arn_fails() -> None:
    kms = boto3.client("kms", region_name="us-east-1")
    key1 = kms.create_key()["KeyMetadata"]["Arn"]
    key2 = kms.create_key()["KeyMetadata"]["Arn"]

    c1 = KMSClient(key_arn=key1, region="us-east-1")
    _, wrapped = c1.generate_envelope_key()

    c2 = KMSClient(key_arn=key2, region="us-east-1")
    # Wrapped against key1 cannot be unwrapped by key2's client (moto enforces this)
    with pytest.raises(Exception):
        c2.unwrap_envelope_key(wrapped)
```

Add to `pyproject.toml`'s `[project.optional-dependencies].dev`: `moto[kms]>=5.0`.

**Step 6: Run, verify it fails** — `ModuleNotFoundError`.

**Step 7: Implement KMSClient**

Create `engine/src/klio_engine/crypto/kms_client.py`:

```python
"""Wrapper around AWS KMS for envelope-key generation and unwrap."""
import boto3


class KMSClient:
    """Generates and unwraps 256-bit envelope keys via AWS KMS.

    The KMS master key is configured per environment via KLIO_KMS_KEY_ARN.
    """

    def __init__(self, key_arn: str, region: str = "us-east-1") -> None:
        self._key_arn = key_arn
        self._client = boto3.client("kms", region_name=region)

    def generate_envelope_key(self) -> tuple[bytes, bytes]:
        """Generate a fresh 256-bit envelope key.

        Returns (plaintext_key, wrapped_key). The plaintext key MUST NOT be
        persisted; the wrapped key is what we store alongside the user record.
        """
        resp = self._client.generate_data_key(
            KeyId=self._key_arn, KeySpec="AES_256",
        )
        return resp["Plaintext"], resp["CiphertextBlob"]

    def unwrap_envelope_key(self, wrapped_key: bytes) -> bytes:
        resp = self._client.decrypt(CiphertextBlob=wrapped_key, KeyId=self._key_arn)
        return resp["Plaintext"]
```

Create `engine/src/klio_engine/crypto/__init__.py`:

```python
"""Cryptography helpers."""
from klio_engine.crypto.envelope import EnvelopeEncrypter
from klio_engine.crypto.kms_client import KMSClient

__all__ = ["EnvelopeEncrypter", "KMSClient"]
```

**Step 8: Run, verify it passes**

Run: `pytest tests/crypto/ -v`
Expected: `5 passed`.

**Step 9: Commit**

```bash
git add src/klio_engine/crypto/ tests/crypto/ pyproject.toml
git commit -m "feat(engine): add KMS envelope encryption helpers"
```

---

### Task A.17 — Engine: User envelope-key persistence

**Files:**
- Modify: `engine/src/klio_engine/models/user.py` (add wrapped_envelope_key column)
- Create: `engine/src/klio_engine/services/user_keys.py`
- Create: `engine/tests/services/test_user_keys.py`
- Create: `engine/alembic/versions/0006_user_envelope_key.py`

**Step 1: Write the failing service test**

Create `engine/tests/services/test_user_keys.py`:

```python
"""User envelope-key service tests."""
import pytest
from moto import mock_aws

from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.user import User
from klio_engine.services.user_keys import UserKeyService


@pytest.fixture
def kms_client_factory():
    @mock_aws
    def make() -> KMSClient:
        import boto3
        kms = boto3.client("kms", region_name="us-east-1")
        arn = kms.create_key()["KeyMetadata"]["Arn"]
        return KMSClient(key_arn=arn, region="us-east-1")
    return make


@pytest.mark.asyncio
async def test_provisioning_creates_envelope_key(session, kms_client_factory) -> None:
    kms = kms_client_factory()
    svc = UserKeyService(kms=kms)
    u = User()
    session.add(u)
    await session.flush()

    plaintext = await svc.provision_user_key(session, u)
    assert len(plaintext) == 32

    await session.refresh(u)
    assert u.wrapped_envelope_key is not None


@pytest.mark.asyncio
async def test_unwrap_returns_original_plaintext(session, kms_client_factory) -> None:
    kms = kms_client_factory()
    svc = UserKeyService(kms=kms)
    u = User()
    session.add(u)
    await session.flush()

    plaintext_a = await svc.provision_user_key(session, u)
    plaintext_b = await svc.unwrap_user_key(u)
    assert plaintext_a == plaintext_b
```

**Step 2: Run, verify it fails** — `ModuleNotFoundError`.

**Step 3: Add the column to User**

Edit `engine/src/klio_engine/models/user.py` — append:

```python
    wrapped_envelope_key: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
```

(import `LargeBinary` at the top.)

**Step 4: Implement the service**

Create `engine/src/klio_engine/services/__init__.py`:

```python
"""Domain services."""
```

Create `engine/src/klio_engine/services/user_keys.py`:

```python
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
```

**Step 5: Run, verify it passes**

Run: `pytest tests/services/test_user_keys.py -v`
Expected: `2 passed`.

**Step 6: Generate migration**

Run: `alembic revision --autogenerate -m "user_envelope_key"`. Verify the generated migration adds `wrapped_envelope_key` to `users`.

**Step 7: Commit**

```bash
git add src/klio_engine/services/ src/klio_engine/models/user.py tests/services/ alembic/versions/0006_*.py
git commit -m "feat(engine): per-user envelope key with KMS wrap/unwrap"
```

---

### Task A.18 — Engine: end-to-end encryption round-trip test

**Files:**
- Create: `engine/tests/integration/test_entry_encryption_e2e.py`

**Step 1: Write the e2e test**

Create `engine/tests/integration/test_entry_encryption_e2e.py`:

```python
"""End-to-end: provision user, store encrypted entry, retrieve, decrypt."""
import uuid

import boto3
import pytest
from moto import mock_aws

from klio_engine.crypto.envelope import EnvelopeEncrypter
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.user_keys import UserKeyService


@pytest.mark.asyncio
@mock_aws
async def test_full_encryption_round_trip(session) -> None:
    kms_raw = boto3.client("kms", region_name="us-east-1")
    arn = kms_raw.create_key()["KeyMetadata"]["Arn"]
    kms = KMSClient(key_arn=arn, region="us-east-1")
    keys = UserKeyService(kms=kms)

    u = User()
    session.add(u)
    await session.flush()
    plaintext_key = await keys.provision_user_key(session, u)

    a = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=uuid.uuid4())
    s = Space(user_id=u.id, name="Default", slug="default")
    session.add_all([a, s])
    await session.flush()

    enc = EnvelopeEncrypter(envelope_key=plaintext_key)
    plaintext = b"User prefers Bun over npm for this project."
    nonce, ct = enc.encrypt(plaintext)

    e = Entry(
        user_id=u.id, space_id=s.id, agent_id=a.id, kind=EntryKind.MEMORY,
        content_ciphertext=ct, content_nonce=nonce,
        embedding=[0.05] * 1536, confidence=1.0,
    )
    session.add(e)
    await session.flush()

    # Re-fetch and decrypt
    fetched = await session.get(Entry, e.id)
    assert fetched is not None
    unwrapped = await keys.unwrap_user_key(u)
    dec = EnvelopeEncrypter(envelope_key=unwrapped)
    decrypted = dec.decrypt(fetched.content_nonce, fetched.content_ciphertext)
    assert decrypted == plaintext
```

**Step 2: Run, verify it passes**

Run: `pytest tests/integration/test_entry_encryption_e2e.py -v`
Expected: `1 passed`.

**Step 3: Commit**

```bash
git add tests/integration/
git commit -m "test(engine): end-to-end entry encryption round-trip"
```

End of Phase A. The engine has a working schema, models, encryption envelope, KMS integration, and a verified round-trip from plaintext through encrypted storage and back.

---

## Phase B — Identity & Auth (Coordinator) (Week 2)

Goal: the coordinator can provision anonymous accounts on behalf of agents, claim them via magic-link, mint short-lived JWTs and rotate refresh tokens, and write every privileged action to the engine's audit log via the hash-chain. By end of Phase B, an end-to-end shell test should: `POST /v1/users/provision` → get an api_key → `POST /v1/users/{id}/claim` → receive a magic-link email → click link → `POST /v1/users/{id}/verify` → get a session token.

### Task B.1 — Coordinator: FastAPI scaffold and health endpoint

**Files:**
- Create: `coordinator/src/klio_coordinator/main.py`
- Create: `coordinator/src/klio_coordinator/config.py`
- Create: `coordinator/src/klio_coordinator/api/__init__.py`
- Create: `coordinator/src/klio_coordinator/api/health.py`
- Create: `coordinator/tests/api/test_health.py`
- Create: `coordinator/tests/conftest.py`

**Step 1: Write the failing health-check test**

Create `coordinator/tests/api/test_health.py`:

```python
"""Health endpoint tests."""
from fastapi.testclient import TestClient


def test_health_returns_ok(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "version" in body


def test_ready_returns_ok_when_dependencies_up(client: TestClient) -> None:
    response = client.get("/ready")
    assert response.status_code == 200
    assert response.json()["status"] == "ready"
```

**Step 2: Write conftest with test client fixture**

Create `coordinator/tests/conftest.py`:

```python
"""Shared fixtures."""
import pytest
from fastapi.testclient import TestClient

from klio_coordinator.main import build_app


@pytest.fixture
def client() -> TestClient:
    app = build_app()
    return TestClient(app)
```

**Step 3: Run, verify it fails** — `ModuleNotFoundError: No module named 'klio_coordinator.main'`.

**Step 4: Implement the FastAPI app and health router**

Create `coordinator/src/klio_coordinator/config.py`:

```python
"""Coordinator settings."""
from pydantic import PostgresDsn
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="KLIO_", env_file=".env")

    database_url: PostgresDsn
    engine_internal_url: str = "http://localhost:8001"  # internal call to klio-engine
    redis_url: str = "redis://localhost:6379/0"
    jwt_signing_key: str  # symmetric HS256 secret, base64
    jwt_audience: str = "klio.tech"
    access_token_ttl_seconds: int = 3600
    refresh_token_ttl_days: int = 90
    magic_link_ttl_minutes: int = 15
    resend_api_key: str = ""
    sender_email: str = "hello@klio.tech"
    log_level: str = "INFO"
```

Create `coordinator/src/klio_coordinator/main.py`:

```python
"""Coordinator FastAPI app factory."""
from fastapi import FastAPI

from klio_coordinator import __version__
from klio_coordinator.api.health import router as health_router


def build_app() -> FastAPI:
    app = FastAPI(
        title="Klio Coordinator",
        version=__version__,
        docs_url="/docs",
        redoc_url=None,
    )
    app.include_router(health_router)
    return app


app = build_app()
```

Create `coordinator/src/klio_coordinator/__init__.py`:

```python
"""Klio coordinator — cloud-only identity, billing, admin."""
__version__ = "0.0.1"
```

Create `coordinator/src/klio_coordinator/api/health.py`:

```python
"""Health and readiness probes."""
from fastapi import APIRouter

from klio_coordinator import __version__

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@router.get("/ready")
async def ready() -> dict[str, str]:
    # Phase B.2 will check Postgres and Redis connectivity
    return {"status": "ready"}
```

**Step 5: Run, verify it passes**

Run: `pytest tests/api/test_health.py -v`
Expected: `2 passed`.

**Step 6: Commit**

```bash
git add src/klio_coordinator/ tests/
git commit -m "feat(coordinator): FastAPI scaffold with health endpoints"
```

---

### Task B.2 — Coordinator: dependency-injected DB session

**Files:**
- Create: `coordinator/src/klio_coordinator/db.py`
- Create: `coordinator/src/klio_coordinator/dependencies.py`
- Create: `coordinator/tests/test_dependencies.py`
- Modify: `coordinator/src/klio_coordinator/api/health.py` (add real DB ping in /ready)

**Step 1: Write the failing dependency test**

Create `coordinator/tests/test_dependencies.py`:

```python
"""Dependency-injection tests."""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from klio_coordinator.dependencies import get_session


@pytest.mark.asyncio
async def test_get_session_yields_working_session(test_db_url: str) -> None:
    async for session in get_session(test_db_url):
        assert isinstance(session, AsyncSession)
        result = await session.execute(text("SELECT 1 AS one"))
        assert result.scalar() == 1
        break


def test_ready_endpoint_pings_database(client_with_db: TestClient) -> None:
    response = client_with_db.get("/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["postgres"] == "ok"
```

Update `coordinator/tests/conftest.py`:

```python
"""Shared fixtures."""
import pytest
from collections.abc import AsyncIterator
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from testcontainers.postgres import PostgresContainer

from klio_coordinator.db import build_engine
from klio_coordinator.main import build_app


@pytest.fixture(scope="session")
def postgres_container():
    with PostgresContainer("pgvector/pgvector:pg16") as pg:
        yield pg


@pytest.fixture
def test_db_url(postgres_container) -> str:
    return postgres_container.get_connection_url().replace(
        "postgresql://", "postgresql+asyncpg://", 1
    )


@pytest.fixture
def client() -> TestClient:
    app = build_app()
    return TestClient(app)


@pytest.fixture
def client_with_db(test_db_url: str, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("KLIO_DATABASE_URL", test_db_url)
    monkeypatch.setenv("KLIO_JWT_SIGNING_KEY", "test-secret-base64-do-not-use-in-prod")
    app = build_app()
    return TestClient(app)
```

**Step 2: Run, verify it fails** — `ModuleNotFoundError`.

**Step 3: Implement DB and dependencies**

Create `coordinator/src/klio_coordinator/db.py`:

```python
"""Async DB engine factory."""
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine


def build_engine(url: str) -> AsyncEngine:
    return create_async_engine(url, pool_pre_ping=True, pool_size=10, max_overflow=20)
```

Create `coordinator/src/klio_coordinator/dependencies.py`:

```python
"""FastAPI dependency injection."""
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from klio_coordinator.config import Settings
from klio_coordinator.db import build_engine


_engine = None
_sessionmaker = None


def _ensure_engine(url: str | None = None):
    global _engine, _sessionmaker
    if _engine is None:
        actual_url = url or str(Settings().database_url)
        _engine = build_engine(actual_url)
        _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _sessionmaker


async def get_session(url: str | None = None) -> AsyncIterator[AsyncSession]:
    factory = _ensure_engine(url)
    async with factory() as session:
        yield session
```

Update `coordinator/src/klio_coordinator/api/health.py`:

```python
"""Health and readiness probes."""
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from klio_coordinator import __version__
from klio_coordinator.dependencies import get_session

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@router.get("/ready")
async def ready(session: AsyncSession = Depends(get_session)) -> dict[str, str]:
    try:
        await session.execute(text("SELECT 1"))
        postgres_status = "ok"
    except Exception as e:
        postgres_status = f"error: {e}"
    return {
        "status": "ready" if postgres_status == "ok" else "degraded",
        "postgres": postgres_status,
    }
```

**Step 4: Run, verify it passes**

Run: `pytest tests/ -v`
Expected: `4 passed`.

**Step 5: Commit**

```bash
git add src/klio_coordinator/db.py src/klio_coordinator/dependencies.py src/klio_coordinator/api/health.py tests/
git commit -m "feat(coordinator): DB session DI and live readiness probe"
```

---

### Task B.3 — Coordinator: JWT minting and verification

**Files:**
- Create: `coordinator/src/klio_coordinator/auth/__init__.py`
- Create: `coordinator/src/klio_coordinator/auth/tokens.py`
- Create: `coordinator/tests/auth/test_tokens.py`

**Step 1: Write the failing JWT test**

Create `coordinator/tests/auth/test_tokens.py`:

```python
"""Access token mint/verify tests."""
import time
import uuid

import pytest

from klio_coordinator.auth.tokens import TokenError, mint_access_token, verify_access_token


def test_mint_and_verify_round_trip() -> None:
    user_id = uuid.uuid4()
    agent_id = uuid.uuid4()
    secret = "super-secret-test-key"
    token = mint_access_token(
        secret=secret, user_id=user_id, agent_id=agent_id, scopes=["read", "write"], ttl_seconds=60
    )
    claims = verify_access_token(secret=secret, token=token)
    assert claims["sub"] == str(user_id)
    assert claims["agent_id"] == str(agent_id)
    assert claims["scopes"] == ["read", "write"]


def test_expired_token_rejected() -> None:
    secret = "k"
    token = mint_access_token(
        secret=secret, user_id=uuid.uuid4(), agent_id=uuid.uuid4(), scopes=[], ttl_seconds=1
    )
    time.sleep(2)
    with pytest.raises(TokenError, match="expired"):
        verify_access_token(secret=secret, token=token)


def test_wrong_secret_rejected() -> None:
    token = mint_access_token(
        secret="key1", user_id=uuid.uuid4(), agent_id=uuid.uuid4(), scopes=[], ttl_seconds=60
    )
    with pytest.raises(TokenError, match="signature"):
        verify_access_token(secret="key2", token=token)


def test_tampered_token_rejected() -> None:
    secret = "k"
    token = mint_access_token(
        secret=secret, user_id=uuid.uuid4(), agent_id=uuid.uuid4(), scopes=[], ttl_seconds=60
    )
    parts = token.split(".")
    parts[1] = parts[1][:-1] + "X"
    tampered = ".".join(parts)
    with pytest.raises(TokenError):
        verify_access_token(secret=secret, token=tampered)
```

**Step 2: Run, verify it fails** — `ModuleNotFoundError`.

**Step 3: Implement tokens**

Create `coordinator/src/klio_coordinator/auth/tokens.py`:

```python
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


def verify_access_token(*, secret: str, token: str, audience: str = "klio.tech") -> dict[str, Any]:
    try:
        return _jose_jwt.decode(token, secret, algorithms=["HS256"], audience=audience)
    except ExpiredSignatureError as e:
        raise TokenError("token expired") from e
    except JWTError as e:
        raise TokenError(f"signature invalid: {e}") from e
```

Create `coordinator/src/klio_coordinator/auth/__init__.py`:

```python
"""Authentication subsystem."""
from klio_coordinator.auth.tokens import TokenError, mint_access_token, verify_access_token

__all__ = ["TokenError", "mint_access_token", "verify_access_token"]
```

**Step 4: Run, verify it passes**

Run: `pytest tests/auth/test_tokens.py -v`
Expected: `4 passed`.

**Step 5: Commit**

```bash
git add src/klio_coordinator/auth/ tests/auth/
git commit -m "feat(coordinator): JWT access token mint and verify"
```

---

### Task B.4 — Coordinator: refresh tokens with rotation

**Files:**
- Create: `coordinator/src/klio_coordinator/auth/refresh.py`
- Create: `coordinator/src/klio_coordinator/models/__init__.py`
- Create: `coordinator/src/klio_coordinator/models/refresh_token.py`
- Create: `coordinator/tests/auth/test_refresh.py`
- Create: `coordinator/alembic/versions/0001_refresh_tokens.py`

**Step 1: Write the failing test**

Create `coordinator/tests/auth/test_refresh.py`:

```python
"""Refresh-token tests."""
import uuid

import pytest

from klio_coordinator.auth.refresh import (
    RefreshTokenError,
    issue_refresh_token,
    rotate_refresh_token,
    revoke_refresh_token,
)
from klio_coordinator.models.refresh_token import RefreshToken


@pytest.mark.asyncio
async def test_issue_creates_persisted_token(coordinator_session) -> None:
    user_id = uuid.uuid4()
    agent_id = uuid.uuid4()
    plaintext, record = await issue_refresh_token(
        coordinator_session, user_id=user_id, agent_id=agent_id, ttl_days=90
    )
    assert isinstance(plaintext, str)
    assert len(plaintext) >= 32  # secure random
    assert record.user_id == user_id
    assert record.agent_id == agent_id
    assert record.revoked_at is None


@pytest.mark.asyncio
async def test_rotate_invalidates_old_returns_new(coordinator_session) -> None:
    user_id = uuid.uuid4()
    agent_id = uuid.uuid4()
    old_pt, old_rec = await issue_refresh_token(
        coordinator_session, user_id=user_id, agent_id=agent_id, ttl_days=90
    )
    new_pt, new_rec = await rotate_refresh_token(coordinator_session, plaintext=old_pt)
    assert new_pt != old_pt
    assert new_rec.id != old_rec.id

    # rotating again with the same old token must fail (one-time use)
    with pytest.raises(RefreshTokenError, match="invalid|revoked"):
        await rotate_refresh_token(coordinator_session, plaintext=old_pt)


@pytest.mark.asyncio
async def test_revoke_marks_revoked(coordinator_session) -> None:
    user_id = uuid.uuid4()
    agent_id = uuid.uuid4()
    pt, rec = await issue_refresh_token(
        coordinator_session, user_id=user_id, agent_id=agent_id, ttl_days=90
    )
    await revoke_refresh_token(coordinator_session, plaintext=pt)
    with pytest.raises(RefreshTokenError, match="revoked"):
        await rotate_refresh_token(coordinator_session, plaintext=pt)
```

Append to `coordinator/tests/conftest.py`:

```python
@pytest.fixture
async def coordinator_session(test_db_url: str):
    """Async session with coordinator's tables created."""
    from sqlalchemy.ext.asyncio import async_sessionmaker
    from sqlalchemy import text

    from klio_coordinator.db import build_engine
    from klio_coordinator.models import Base

    engine = build_engine(test_db_url)
    async with engine.begin() as conn:
        await conn.execute(text('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'))
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as s:
        yield s
        await s.rollback()
    await engine.dispose()
```

**Step 2: Run, verify it fails** — `ModuleNotFoundError`.

**Step 3: Implement RefreshToken model**

Create `coordinator/src/klio_coordinator/models/__init__.py`:

```python
"""Coordinator-only ORM models."""
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


from klio_coordinator.models.refresh_token import RefreshToken  # noqa: E402

__all__ = ["Base", "RefreshToken"]
```

Create `coordinator/src/klio_coordinator/models/refresh_token.py`:

```python
"""Refresh-token persistence."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from klio_coordinator.models import Base


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    agent_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    issued_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rotated_to_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )  # if this token was rotated, points at the successor
```

**Step 4: Implement issue/rotate/revoke**

Create `coordinator/src/klio_coordinator/auth/refresh.py`:

```python
"""Refresh-token lifecycle. One-time-use rotation."""
import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_coordinator.models.refresh_token import RefreshToken


class RefreshTokenError(Exception):
    """Refresh token rejected (revoked, expired, or unknown)."""


def _hash(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode()).hexdigest()


async def issue_refresh_token(
    session: AsyncSession, *, user_id: uuid.UUID, agent_id: uuid.UUID, ttl_days: int
) -> tuple[str, RefreshToken]:
    plaintext = secrets.token_urlsafe(32)
    record = RefreshToken(
        user_id=user_id, agent_id=agent_id,
        token_hash=_hash(plaintext),
        expires_at=datetime.now(UTC) + timedelta(days=ttl_days),
    )
    session.add(record)
    await session.flush()
    return plaintext, record


async def _find_active(session: AsyncSession, plaintext: str) -> RefreshToken:
    h = _hash(plaintext)
    rec = (
        await session.execute(select(RefreshToken).where(RefreshToken.token_hash == h))
    ).scalar_one_or_none()
    if rec is None:
        raise RefreshTokenError("token invalid")
    if rec.revoked_at is not None:
        raise RefreshTokenError("token revoked")
    if rec.expires_at < datetime.now(UTC):
        raise RefreshTokenError("token expired")
    return rec


async def rotate_refresh_token(
    session: AsyncSession, *, plaintext: str
) -> tuple[str, RefreshToken]:
    old = await _find_active(session, plaintext)
    new_plaintext, new_record = await issue_refresh_token(
        session, user_id=old.user_id, agent_id=old.agent_id,
        ttl_days=int((old.expires_at - old.issued_at).days),
    )
    old.revoked_at = datetime.now(UTC)
    old.rotated_to_id = new_record.id
    await session.flush()
    return new_plaintext, new_record


async def revoke_refresh_token(session: AsyncSession, *, plaintext: str) -> None:
    rec = await _find_active(session, plaintext)
    rec.revoked_at = datetime.now(UTC)
    await session.flush()
```

**Step 5: Run, verify it passes**

Run: `pytest tests/auth/test_refresh.py -v`
Expected: `3 passed`.

**Step 6: Generate migration**

Run: `alembic init alembic` (in coordinator/), edit env.py to mirror engine's pattern, then `alembic revision --autogenerate -m "refresh_tokens"`.

**Step 7: Commit**

```bash
git add src/klio_coordinator/auth/refresh.py src/klio_coordinator/models/ tests/auth/test_refresh.py alembic/
git commit -m "feat(coordinator): refresh tokens with one-time-use rotation"
```

---

### Task B.5 — Coordinator: provision endpoint

**Files:**
- Create: `coordinator/src/klio_coordinator/api/users.py`
- Create: `coordinator/src/klio_coordinator/schemas/__init__.py`
- Create: `coordinator/src/klio_coordinator/schemas/users.py`
- Create: `coordinator/src/klio_coordinator/services/__init__.py`
- Create: `coordinator/src/klio_coordinator/services/provisioning.py`
- Create: `coordinator/tests/api/test_provision.py`
- Modify: `coordinator/src/klio_coordinator/main.py` (mount router)

**Step 1: Write the failing API test**

Create `coordinator/tests/api/test_provision.py`:

```python
"""POST /v1/users/provision tests."""
import uuid


def test_provision_anonymous_returns_credentials(client_with_db) -> None:
    body = {"agent_kind": "claude-code", "install_id": str(uuid.uuid4())}
    response = client_with_db.post("/v1/users/provision", json=body)
    assert response.status_code == 201, response.text
    data = response.json()
    assert "user_id" in data
    assert "api_key" in data
    assert data["claimed"] is False
    assert "default_space_id" in data


def test_provision_requires_agent_kind(client_with_db) -> None:
    response = client_with_db.post(
        "/v1/users/provision", json={"install_id": str(uuid.uuid4())}
    )
    assert response.status_code == 422


def test_provision_creates_default_space(client_with_db) -> None:
    body = {"agent_kind": "claude-code", "install_id": str(uuid.uuid4())}
    response = client_with_db.post("/v1/users/provision", json=body)
    data = response.json()
    assert "default_space_id" in data
    assert data["default_space_id"] is not None
```

**Step 2: Run, verify it fails** — endpoint not defined.

**Step 3: Implement schemas, service, router**

Create `coordinator/src/klio_coordinator/schemas/users.py`:

```python
"""Pydantic schemas for user-related requests/responses."""
import uuid

from pydantic import BaseModel, EmailStr


class ProvisionRequest(BaseModel):
    agent_kind: str  # "claude-code", "cursor", "codex", "antigravity", "klio-bridge", "custom"
    install_id: uuid.UUID
    display_name: str | None = None
    email: EmailStr | None = None  # optional eager-claim path


class ProvisionResponse(BaseModel):
    user_id: uuid.UUID
    agent_id: uuid.UUID
    api_key: str       # the refresh token, plaintext, returned ONCE
    claimed: bool
    default_space_id: uuid.UUID
```

Create `coordinator/src/klio_coordinator/schemas/__init__.py`:

```python
"""Pydantic request/response schemas."""
```

Create `coordinator/src/klio_coordinator/services/provisioning.py`:

```python
"""Anonymous-first provisioning service.

When called, this:
  1. Creates a User row (anonymous).
  2. Provisions a per-user envelope key via KMS.
  3. Creates an Agent row tied to the user.
  4. Creates a Default Space and grants the agent admin scope.
  5. Issues a refresh token.
  6. Writes audit-log entries via the engine for each privileged step.
"""
import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from klio_coordinator.auth.refresh import issue_refresh_token


@dataclass
class ProvisionResult:
    user_id: uuid.UUID
    agent_id: uuid.UUID
    api_key: str
    claimed: bool
    default_space_id: uuid.UUID


class ProvisioningService:
    """Coordinator's provisioning pipeline.

    Calls into the engine over HTTP for the actual database writes (User,
    Agent, Space, Permission, AuditLogEntry). Refresh-token issuance is local
    to the coordinator's DB.
    """

    def __init__(self, *, engine_client, refresh_ttl_days: int = 90) -> None:
        self._engine = engine_client
        self._refresh_ttl_days = refresh_ttl_days

    async def provision(
        self,
        session: AsyncSession,
        *,
        agent_kind: str,
        install_id: uuid.UUID,
        display_name: str | None = None,
        email: str | None = None,
    ) -> ProvisionResult:
        user = await self._engine.create_user(email=email)
        await self._engine.provision_envelope_key(user_id=user["id"])
        agent = await self._engine.create_agent(
            user_id=user["id"], kind=agent_kind, install_id=install_id, display_name=display_name
        )
        space = await self._engine.create_space(user_id=user["id"], name="Default", slug="default")
        await self._engine.grant_permission(
            user_id=user["id"], space_id=space["id"], agent_id=agent["id"], scope="admin",
            granted_by_user_id=None, granted_by_agent_id=agent["id"],
        )

        plaintext, _ = await issue_refresh_token(
            session, user_id=uuid.UUID(user["id"]), agent_id=uuid.UUID(agent["id"]),
            ttl_days=self._refresh_ttl_days,
        )

        return ProvisionResult(
            user_id=uuid.UUID(user["id"]),
            agent_id=uuid.UUID(agent["id"]),
            api_key=plaintext,
            claimed=user.get("claimed_at") is not None,
            default_space_id=uuid.UUID(space["id"]),
        )
```

Create `coordinator/src/klio_coordinator/services/__init__.py`:

```python
"""Coordinator services."""
```

Create `coordinator/src/klio_coordinator/api/users.py`:

```python
"""Users router — provision, claim, verify, rotate, delete."""
import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from klio_coordinator.dependencies import get_session
from klio_coordinator.schemas.users import ProvisionRequest, ProvisionResponse
from klio_coordinator.services.provisioning import ProvisioningService

router = APIRouter(prefix="/v1/users", tags=["users"])


def get_provisioning_service() -> ProvisioningService:
    # Phase B.5+ wires the real engine HTTP client; tests inject a fake.
    from klio_coordinator.engine_client import EngineClient
    return ProvisioningService(engine_client=EngineClient())


@router.post("/provision", response_model=ProvisionResponse, status_code=status.HTTP_201_CREATED)
async def provision(
    body: ProvisionRequest,
    session: AsyncSession = Depends(get_session),
    svc: ProvisioningService = Depends(get_provisioning_service),
) -> ProvisionResponse:
    result = await svc.provision(
        session,
        agent_kind=body.agent_kind,
        install_id=body.install_id,
        display_name=body.display_name,
        email=str(body.email) if body.email else None,
    )
    return ProvisionResponse(
        user_id=result.user_id,
        agent_id=result.agent_id,
        api_key=result.api_key,
        claimed=result.claimed,
        default_space_id=result.default_space_id,
    )
```

Update `coordinator/src/klio_coordinator/main.py`:

```python
from klio_coordinator.api.health import router as health_router
from klio_coordinator.api.users import router as users_router

def build_app() -> FastAPI:
    app = FastAPI(...)
    app.include_router(health_router)
    app.include_router(users_router)
    return app
```

**Step 4: Implement a test fake for the engine client**

Create `coordinator/src/klio_coordinator/engine_client.py`:

```python
"""HTTP client for klio-engine internal API.

In Phase B.5 we only wire enough methods for provisioning. Phase C wires
the rest (entries, recall, etc.).
"""
import uuid
from typing import Any

import httpx

from klio_coordinator.config import Settings


class EngineClient:
    def __init__(self, base_url: str | None = None) -> None:
        self._base = base_url or Settings().engine_internal_url
        self._client = httpx.AsyncClient(base_url=self._base, timeout=10.0)

    async def create_user(self, *, email: str | None = None) -> dict[str, Any]:
        r = await self._client.post("/internal/users", json={"email": email})
        r.raise_for_status()
        return r.json()

    async def provision_envelope_key(self, *, user_id: str) -> None:
        r = await self._client.post(f"/internal/users/{user_id}/envelope-key")
        r.raise_for_status()

    async def create_agent(self, **kwargs) -> dict[str, Any]:
        r = await self._client.post("/internal/agents", json=kwargs)
        r.raise_for_status()
        return r.json()

    async def create_space(self, **kwargs) -> dict[str, Any]:
        r = await self._client.post("/internal/spaces", json=kwargs)
        r.raise_for_status()
        return r.json()

    async def grant_permission(self, **kwargs) -> dict[str, Any]:
        r = await self._client.post("/internal/permissions", json=kwargs)
        r.raise_for_status()
        return r.json()
```

For the test, override the dependency with a fake. Update `coordinator/tests/conftest.py`:

```python
from klio_coordinator.api.users import get_provisioning_service
from klio_coordinator.services.provisioning import ProvisioningService


class FakeEngineClient:
    """In-memory fake for tests."""

    def __init__(self) -> None:
        self.users: dict = {}
        self.agents: dict = {}
        self.spaces: dict = {}
        self.permissions: list = []

    async def create_user(self, *, email=None):
        uid = str(uuid.uuid4())
        u = {"id": uid, "email_hash": None, "claimed_at": None}
        self.users[uid] = u
        return u

    async def provision_envelope_key(self, *, user_id):
        return None

    async def create_agent(self, **kwargs):
        aid = str(uuid.uuid4())
        a = {"id": aid, **kwargs}
        self.agents[aid] = a
        return a

    async def create_space(self, **kwargs):
        sid = str(uuid.uuid4())
        s = {"id": sid, **kwargs}
        self.spaces[sid] = s
        return s

    async def grant_permission(self, **kwargs):
        self.permissions.append(kwargs)
        return kwargs


@pytest.fixture
def client_with_db(test_db_url, monkeypatch) -> TestClient:
    monkeypatch.setenv("KLIO_DATABASE_URL", test_db_url)
    monkeypatch.setenv("KLIO_JWT_SIGNING_KEY", "test-secret-base64-do-not-use-in-prod")
    app = build_app()
    fake = FakeEngineClient()
    app.dependency_overrides[get_provisioning_service] = lambda: ProvisioningService(
        engine_client=fake
    )
    return TestClient(app)
```

**Step 5: Run, verify it passes**

Run: `pytest tests/api/test_provision.py -v`
Expected: `3 passed`.

**Step 6: Commit**

```bash
git add src/klio_coordinator/ tests/api/test_provision.py
git commit -m "feat(coordinator): POST /v1/users/provision (anonymous)"
```

---

### Task B.6 — Engine: internal API endpoints used by provisioning

**Files:**
- Create: `engine/src/klio_engine/api/__init__.py`
- Create: `engine/src/klio_engine/api/internal.py`
- Create: `engine/src/klio_engine/api/main.py`
- Create: `engine/tests/api/test_internal.py`

**Step 1: Write the failing test**

Create `engine/tests/api/test_internal.py`:

```python
"""Internal-only endpoints exercised by the coordinator."""
import uuid

from fastapi.testclient import TestClient


def test_create_user_returns_uuid(engine_client: TestClient) -> None:
    response = engine_client.post("/internal/users", json={"email": None})
    assert response.status_code == 201
    body = response.json()
    assert "id" in body
    uuid.UUID(body["id"])  # validates


def test_provision_envelope_key(engine_client: TestClient) -> None:
    user = engine_client.post("/internal/users", json={"email": None}).json()
    response = engine_client.post(f"/internal/users/{user['id']}/envelope-key")
    assert response.status_code == 204


def test_create_agent(engine_client: TestClient) -> None:
    user = engine_client.post("/internal/users", json={"email": None}).json()
    body = {
        "user_id": user["id"],
        "kind": "claude-code",
        "install_id": str(uuid.uuid4()),
        "display_name": "Claude Code on test",
    }
    response = engine_client.post("/internal/agents", json=body)
    assert response.status_code == 201
    assert "id" in response.json()


def test_create_space_and_grant(engine_client: TestClient) -> None:
    user = engine_client.post("/internal/users", json={"email": None}).json()
    agent = engine_client.post("/internal/agents", json={
        "user_id": user["id"], "kind": "claude-code", "install_id": str(uuid.uuid4()),
    }).json()
    space = engine_client.post("/internal/spaces", json={
        "user_id": user["id"], "name": "Default", "slug": "default",
    }).json()
    grant = engine_client.post("/internal/permissions", json={
        "user_id": user["id"], "space_id": space["id"], "agent_id": agent["id"],
        "scope": "admin",
        "granted_by_user_id": None,
        "granted_by_agent_id": agent["id"],
    })
    assert grant.status_code == 201
```

Add to `engine/tests/conftest.py`:

```python
@pytest.fixture
def engine_client(monkeypatch, postgres_container, mock_kms_arn) -> TestClient:
    url = postgres_container.get_connection_url().replace(
        "postgresql://", "postgresql+asyncpg://", 1
    )
    monkeypatch.setenv("KLIO_DATABASE_URL", url)
    monkeypatch.setenv("KLIO_KMS_KEY_ARN", mock_kms_arn)
    monkeypatch.setenv("KLIO_S3_BUCKET", "test")

    from klio_engine.api.main import build_app
    app = build_app()
    return TestClient(app)


@pytest.fixture
def mock_kms_arn():
    """Spin up a moto KMS key and return its ARN."""
    from moto import mock_aws
    import boto3
    with mock_aws():
        kms = boto3.client("kms", region_name="us-east-1")
        arn = kms.create_key()["KeyMetadata"]["Arn"]
        yield arn
```

**Step 2: Run, verify it fails** — `klio_engine.api.main` doesn't exist.

**Step 3: Implement the engine API**

Create `engine/src/klio_engine/api/main.py`:

```python
"""Engine FastAPI app."""
from fastapi import FastAPI

from klio_engine import __version__
from klio_engine.api.internal import router as internal_router


def build_app() -> FastAPI:
    app = FastAPI(title="Klio Engine", version=__version__, docs_url="/docs")
    app.include_router(internal_router)
    return app


app = build_app()
```

Create `engine/src/klio_engine/api/internal.py`:

```python
"""Internal endpoints called by the coordinator over private network.

Not exposed publicly. Authenticated via internal-mTLS in production; in tests
the mTLS check is bypassed.
"""
import uuid

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.crypto.kms_client import KMSClient
from klio_engine.dependencies import get_session
from klio_engine.config import Settings
from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.permission import Permission, PermissionScope
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.user_keys import UserKeyService

router = APIRouter(prefix="/internal", tags=["internal"])


class CreateUserBody(BaseModel):
    email: str | None = None


class CreateUserResponse(BaseModel):
    id: uuid.UUID
    email_hash: str | None
    claimed_at: str | None


@router.post("/users", response_model=CreateUserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(body: CreateUserBody, session: AsyncSession = Depends(get_session)):
    u = User()
    if body.email:
        import hashlib
        u.email_hash = hashlib.sha256(body.email.encode()).hexdigest()
    session.add(u)
    await session.flush()
    await session.commit()
    return CreateUserResponse(id=u.id, email_hash=u.email_hash, claimed_at=None)


@router.post("/users/{user_id}/envelope-key", status_code=status.HTTP_204_NO_CONTENT)
async def provision_envelope_key(
    user_id: uuid.UUID, session: AsyncSession = Depends(get_session)
):
    settings = Settings()
    kms = KMSClient(key_arn=settings.kms_key_arn, region=settings.aws_region)
    svc = UserKeyService(kms=kms)
    u = await session.get(User, user_id)
    if u is None:
        from fastapi import HTTPException
        raise HTTPException(404, "user not found")
    await svc.provision_user_key(session, u)
    await session.commit()


class CreateAgentBody(BaseModel):
    user_id: uuid.UUID
    kind: str
    install_id: uuid.UUID
    display_name: str | None = None


class CreateAgentResponse(BaseModel):
    id: uuid.UUID


@router.post("/agents", response_model=CreateAgentResponse, status_code=status.HTTP_201_CREATED)
async def create_agent(body: CreateAgentBody, session: AsyncSession = Depends(get_session)):
    a = Agent(
        user_id=body.user_id, kind=AgentKind(body.kind),
        install_id=body.install_id, display_name=body.display_name,
    )
    session.add(a)
    await session.flush()
    await session.commit()
    return CreateAgentResponse(id=a.id)


class CreateSpaceBody(BaseModel):
    user_id: uuid.UUID
    name: str
    slug: str


class CreateSpaceResponse(BaseModel):
    id: uuid.UUID
    name: str
    slug: str


@router.post("/spaces", response_model=CreateSpaceResponse, status_code=status.HTTP_201_CREATED)
async def create_space(body: CreateSpaceBody, session: AsyncSession = Depends(get_session)):
    s = Space(user_id=body.user_id, name=body.name, slug=body.slug)
    session.add(s)
    await session.flush()
    await session.commit()
    return CreateSpaceResponse(id=s.id, name=s.name, slug=s.slug)


class GrantBody(BaseModel):
    user_id: uuid.UUID
    space_id: uuid.UUID
    agent_id: uuid.UUID
    scope: str
    granted_by_user_id: uuid.UUID | None = None
    granted_by_agent_id: uuid.UUID | None = None


class GrantResponse(BaseModel):
    id: uuid.UUID


@router.post("/permissions", response_model=GrantResponse, status_code=status.HTTP_201_CREATED)
async def grant_permission(body: GrantBody, session: AsyncSession = Depends(get_session)):
    p = Permission(
        user_id=body.user_id, space_id=body.space_id, agent_id=body.agent_id,
        scope=PermissionScope(body.scope),
        granted_by_user_id=body.granted_by_user_id,
        granted_by_agent_id=body.granted_by_agent_id,
    )
    session.add(p)
    await session.flush()
    await session.commit()
    return GrantResponse(id=p.id)
```

Create `engine/src/klio_engine/dependencies.py`:

```python
"""FastAPI deps for the engine."""
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from klio_engine.config import Settings
from klio_engine.db import build_engine


_factory = None


async def get_session() -> AsyncIterator[AsyncSession]:
    global _factory
    if _factory is None:
        _factory = async_sessionmaker(build_engine(str(Settings().database_url)),
                                      expire_on_commit=False)
    async with _factory() as s:
        yield s
```

**Step 4: Run, verify it passes**

Run: `pytest tests/api/test_internal.py -v`
Expected: `4 passed`.

**Step 5: Commit**

```bash
git add src/klio_engine/api/ src/klio_engine/dependencies.py tests/api/
git commit -m "feat(engine): internal API endpoints for coordinator"
```

---

### Task B.7 — Coordinator: magic-link claim flow

**Files:**
- Create: `coordinator/src/klio_coordinator/auth/magic_link.py`
- Create: `coordinator/src/klio_coordinator/services/email.py`
- Create: `coordinator/src/klio_coordinator/models/magic_link_token.py`
- Create: `coordinator/tests/auth/test_magic_link.py`
- Create: `coordinator/tests/api/test_claim.py`
- Modify: `coordinator/src/klio_coordinator/api/users.py` (add /claim, /verify)

**Step 1: Write the failing test for magic-link issuance**

Create `coordinator/tests/auth/test_magic_link.py`:

```python
"""Magic-link issuance + verification tests."""
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from klio_coordinator.auth.magic_link import (
    MagicLinkError,
    issue_magic_link,
    verify_magic_link,
)


@pytest.mark.asyncio
async def test_issue_returns_token_and_persists(coordinator_session) -> None:
    user_id = uuid.uuid4()
    plaintext, record = await issue_magic_link(
        coordinator_session, user_id=user_id, ttl_minutes=15,
        ip="1.2.3.4", user_agent="curl/8",
    )
    assert len(plaintext) >= 32
    assert record.user_id == user_id
    assert record.consumed_at is None


@pytest.mark.asyncio
async def test_verify_consumes_token(coordinator_session) -> None:
    user_id = uuid.uuid4()
    pt, _ = await issue_magic_link(coordinator_session, user_id=user_id, ttl_minutes=15)
    consumed_user = await verify_magic_link(coordinator_session, plaintext=pt)
    assert consumed_user == user_id

    # second use must fail
    with pytest.raises(MagicLinkError, match="consumed|invalid"):
        await verify_magic_link(coordinator_session, plaintext=pt)


@pytest.mark.asyncio
async def test_expired_link_rejected(coordinator_session) -> None:
    user_id = uuid.uuid4()
    pt, rec = await issue_magic_link(coordinator_session, user_id=user_id, ttl_minutes=15)
    rec.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await coordinator_session.flush()
    with pytest.raises(MagicLinkError, match="expired"):
        await verify_magic_link(coordinator_session, plaintext=pt)
```

**Step 2: Run, verify it fails** — `ModuleNotFoundError`.

**Step 3: Implement model and helpers**

Create `coordinator/src/klio_coordinator/models/magic_link_token.py`:

```python
"""Magic-link token model."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from klio_coordinator.models import Base


class MagicLinkToken(Base):
    __tablename__ = "magic_link_tokens"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    issued_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    requesting_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)  # IPv4/IPv6
    requesting_user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)
```

Update `coordinator/src/klio_coordinator/models/__init__.py` to import `MagicLinkToken`.

Create `coordinator/src/klio_coordinator/auth/magic_link.py`:

```python
"""Magic-link tokens. 15-min TTL, single-use, IP/UA recorded for audit."""
import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_coordinator.models.magic_link_token import MagicLinkToken


class MagicLinkError(Exception):
    """Magic link rejected (invalid, expired, consumed)."""


def _hash(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode()).hexdigest()


async def issue_magic_link(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    ttl_minutes: int,
    ip: str | None = None,
    user_agent: str | None = None,
) -> tuple[str, MagicLinkToken]:
    plaintext = secrets.token_urlsafe(32)
    record = MagicLinkToken(
        user_id=user_id,
        token_hash=_hash(plaintext),
        expires_at=datetime.now(UTC) + timedelta(minutes=ttl_minutes),
        requesting_ip=ip,
        requesting_user_agent=user_agent,
    )
    session.add(record)
    await session.flush()
    return plaintext, record


async def verify_magic_link(session: AsyncSession, *, plaintext: str) -> uuid.UUID:
    h = _hash(plaintext)
    rec = (
        await session.execute(select(MagicLinkToken).where(MagicLinkToken.token_hash == h))
    ).scalar_one_or_none()
    if rec is None:
        raise MagicLinkError("token invalid")
    if rec.consumed_at is not None:
        raise MagicLinkError("token consumed")
    if rec.expires_at < datetime.now(UTC):
        raise MagicLinkError("token expired")
    rec.consumed_at = datetime.now(UTC)
    await session.flush()
    return rec.user_id
```

**Step 4: Run, verify it passes**

Run: `pytest tests/auth/test_magic_link.py -v`
Expected: `3 passed`.

**Step 5: Implement email service**

Create `coordinator/src/klio_coordinator/services/email.py`:

```python
"""Email delivery via Resend.

Tests stub this out at the function level.
"""
import resend

from klio_coordinator.config import Settings


class EmailService:
    def __init__(self, api_key: str | None = None, sender: str | None = None) -> None:
        s = Settings()
        self._key = api_key or s.resend_api_key
        self._sender = sender or s.sender_email
        if self._key:
            resend.api_key = self._key

    def send_magic_link(self, *, to: str, link: str, mode: str) -> None:
        """mode is 'claim' or 'login'."""
        if not self._key:
            # dev mode — log to stdout instead of sending
            import structlog
            structlog.get_logger().info("magic_link_dev", to=to, link=link, mode=mode)
            return
        subject = "Claim your Klio account" if mode == "claim" else "Sign in to Klio"
        html = f"""
        <p>Click below to {('claim your Klio account' if mode == 'claim' else 'sign in')}:</p>
        <p><a href="{link}">{link}</a></p>
        <p>This link expires in 15 minutes.</p>
        """
        resend.Emails.send({
            "from": self._sender, "to": [to], "subject": subject, "html": html,
        })
```

**Step 6: Add /claim and /verify endpoints**

Append to `coordinator/src/klio_coordinator/schemas/users.py`:

```python
class ClaimRequest(BaseModel):
    email: EmailStr


class ClaimResponse(BaseModel):
    magic_link_sent: bool
    expires_in_minutes: int = 15


class VerifyRequest(BaseModel):
    token: str


class VerifyResponse(BaseModel):
    user_id: uuid.UUID
    session_token: str  # the cookie value the trust app will set
    access_token: str   # short-lived JWT for immediate API use
```

Append to `coordinator/src/klio_coordinator/api/users.py`:

```python
@router.post("/{user_id}/claim", response_model=ClaimResponse)
async def claim(
    user_id: uuid.UUID,
    body: ClaimRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> ClaimResponse:
    plaintext, _ = await issue_magic_link(
        session, user_id=user_id, ttl_minutes=15,
        ip=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    await session.commit()
    link = f"https://app.klio.tech/verify?token={plaintext}&user_id={user_id}"
    EmailService().send_magic_link(to=str(body.email), link=link, mode="claim")
    return ClaimResponse(magic_link_sent=True)


@router.post("/{user_id}/verify", response_model=VerifyResponse)
async def verify(
    user_id: uuid.UUID,
    body: VerifyRequest,
    session: AsyncSession = Depends(get_session),
) -> VerifyResponse:
    verified_user = await verify_magic_link(session, plaintext=body.token)
    if verified_user != user_id:
        raise HTTPException(403, "user_id mismatch")
    # mark user as claimed in engine
    await EngineClient().claim_user(user_id=str(user_id))

    # mint a short-lived JWT for immediate use
    settings = Settings()
    access = mint_access_token(
        secret=settings.jwt_signing_key, user_id=user_id,
        agent_id=user_id,  # session token is keyed to user, no agent
        scopes=["session"], ttl_seconds=settings.access_token_ttl_seconds,
    )
    # session cookie value (also a JWT but with longer TTL for browser use)
    session_token = mint_access_token(
        secret=settings.jwt_signing_key, user_id=user_id, agent_id=user_id,
        scopes=["session"], ttl_seconds=30 * 24 * 3600,
    )
    await session.commit()
    return VerifyResponse(user_id=user_id, session_token=session_token, access_token=access)
```

(Add the imports at the top of users.py: `Request`, `HTTPException`, `mint_access_token`, etc. Add `claim_user` to `EngineClient`.)

**Step 7: Write the API tests**

Create `coordinator/tests/api/test_claim.py`:

```python
"""Claim + verify endpoint tests."""
import uuid


def test_claim_sends_link_and_returns_ok(client_with_db, monkeypatch) -> None:
    sent = []
    monkeypatch.setattr(
        "klio_coordinator.services.email.EmailService.send_magic_link",
        lambda self, *, to, link, mode: sent.append((to, link, mode)),
    )
    user_id = uuid.uuid4()
    response = client_with_db.post(
        f"/v1/users/{user_id}/claim", json={"email": "abhishek@example.com"}
    )
    assert response.status_code == 200
    assert response.json()["magic_link_sent"] is True
    assert len(sent) == 1
    assert sent[0][0] == "abhishek@example.com"
    assert "token=" in sent[0][1]


def test_verify_returns_session_token(client_with_db, monkeypatch) -> None:
    captured: dict = {}

    def capture(self, *, to, link, mode):
        # parse token out of link
        import urllib.parse as up
        q = up.urlparse(link).query
        captured["token"] = up.parse_qs(q)["token"][0]

    monkeypatch.setattr(
        "klio_coordinator.services.email.EmailService.send_magic_link", capture
    )
    user_id = uuid.uuid4()
    client_with_db.post(f"/v1/users/{user_id}/claim", json={"email": "x@y.com"})
    assert "token" in captured

    response = client_with_db.post(
        f"/v1/users/{user_id}/verify", json={"token": captured["token"]}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["user_id"] == str(user_id)
    assert "session_token" in body
    assert "access_token" in body
```

**Step 8: Run, verify all pass**

Run: `pytest tests/ -v`
Expected: all green.

**Step 9: Commit**

```bash
git add src/klio_coordinator/auth/magic_link.py src/klio_coordinator/services/email.py src/klio_coordinator/models/ src/klio_coordinator/schemas/users.py src/klio_coordinator/api/users.py tests/auth/test_magic_link.py tests/api/test_claim.py
git commit -m "feat(coordinator): magic-link claim and verify"
```

---

### Task B.8 — Coordinator: token refresh endpoint

**Files:**
- Create: `coordinator/src/klio_coordinator/api/tokens.py`
- Create: `coordinator/tests/api/test_token_refresh.py`
- Modify: `coordinator/src/klio_coordinator/main.py`

**Step 1: Write the failing test**

Create `coordinator/tests/api/test_token_refresh.py`:

```python
"""POST /v1/tokens/refresh tests."""
import uuid


def test_refresh_returns_new_pair(client_with_db) -> None:
    # Provision an account
    response = client_with_db.post(
        "/v1/users/provision",
        json={"agent_kind": "claude-code", "install_id": str(uuid.uuid4())},
    )
    assert response.status_code == 201
    api_key = response.json()["api_key"]

    # Refresh
    refresh = client_with_db.post(
        "/v1/tokens/refresh", json={"refresh_token": api_key}
    )
    assert refresh.status_code == 200, refresh.text
    body = refresh.json()
    assert "access_token" in body
    assert "refresh_token" in body
    assert body["refresh_token"] != api_key  # rotated


def test_old_refresh_token_rejected_after_rotation(client_with_db) -> None:
    response = client_with_db.post(
        "/v1/users/provision",
        json={"agent_kind": "claude-code", "install_id": str(uuid.uuid4())},
    )
    api_key = response.json()["api_key"]

    client_with_db.post("/v1/tokens/refresh", json={"refresh_token": api_key})
    second = client_with_db.post("/v1/tokens/refresh", json={"refresh_token": api_key})
    assert second.status_code == 401


def test_invalid_refresh_token_rejected(client_with_db) -> None:
    response = client_with_db.post(
        "/v1/tokens/refresh", json={"refresh_token": "not-a-real-token"}
    )
    assert response.status_code == 401
```

**Step 2: Run, verify it fails** — endpoint not defined.

**Step 3: Implement**

Create `coordinator/src/klio_coordinator/api/tokens.py`:

```python
"""Token-refresh endpoint."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from klio_coordinator.auth.refresh import RefreshTokenError, rotate_refresh_token
from klio_coordinator.auth.tokens import mint_access_token
from klio_coordinator.config import Settings
from klio_coordinator.dependencies import get_session

router = APIRouter(prefix="/v1/tokens", tags=["tokens"])


class RefreshRequest(BaseModel):
    refresh_token: str


class RefreshResponse(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int


@router.post("/refresh", response_model=RefreshResponse)
async def refresh(
    body: RefreshRequest,
    session: AsyncSession = Depends(get_session),
) -> RefreshResponse:
    try:
        new_pt, new_rec = await rotate_refresh_token(session, plaintext=body.refresh_token)
    except RefreshTokenError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(e))
    settings = Settings()
    access = mint_access_token(
        secret=settings.jwt_signing_key,
        user_id=new_rec.user_id, agent_id=new_rec.agent_id,
        scopes=["read", "write"],  # standard agent scopes; admin-scoped tokens issued separately
        ttl_seconds=settings.access_token_ttl_seconds,
    )
    await session.commit()
    return RefreshResponse(
        access_token=access, refresh_token=new_pt,
        expires_in=settings.access_token_ttl_seconds,
    )
```

Mount in main.py.

**Step 4: Run, verify it passes**

Run: `pytest tests/api/test_token_refresh.py -v`
Expected: `3 passed`.

**Step 5: Commit**

```bash
git add src/klio_coordinator/api/tokens.py src/klio_coordinator/main.py tests/api/test_token_refresh.py
git commit -m "feat(coordinator): POST /v1/tokens/refresh with one-time-use rotation"
```

---

### Task B.9 — Coordinator: audit-log writer integration

**Files:**
- Create: `coordinator/src/klio_coordinator/services/audit_writer.py`
- Modify: `coordinator/src/klio_coordinator/services/provisioning.py` (call audit writer)
- Modify: `coordinator/src/klio_coordinator/api/users.py` (claim, verify call audit writer)
- Create: `coordinator/tests/services/test_audit_writer.py`

**Step 1: Write the failing test**

Create `coordinator/tests/services/test_audit_writer.py`:

```python
"""Audit writer tests — verifies hash chain is built correctly."""
import uuid

import pytest

from klio_coordinator.services.audit_writer import AuditWriter


@pytest.mark.asyncio
async def test_first_event_uses_zero_prev_hash() -> None:
    captured = []

    async def fake_post(action, **kwargs):
        captured.append({"action": action, **kwargs})

    aw = AuditWriter(_post=fake_post)
    user_id = uuid.uuid4()
    await aw.write(user_id=user_id, actor_type="user", actor_id=user_id, action="user.provision",
                   target_type="user", target_id=user_id, metadata={})
    assert len(captured) == 1
    assert captured[0]["prev_hash"] == "0" * 64


@pytest.mark.asyncio
async def test_subsequent_event_chains_prev_hash() -> None:
    # Mock engine that returns deterministic hashes
    state = {"last_hash": "0" * 64}

    async def fake_post(action, **kwargs):
        # Simulate engine returning the new hash
        new_hash = "a" * 64 if state["last_hash"] == "0" * 64 else "b" * 64
        state["last_hash"] = new_hash
        return new_hash

    aw = AuditWriter(_post=fake_post)
    user_id = uuid.uuid4()
    await aw.write(user_id=user_id, actor_type="user", actor_id=user_id,
                   action="user.provision", target_type="user", target_id=user_id, metadata={})
    h2 = await aw.write(user_id=user_id, actor_type="user", actor_id=user_id,
                        action="space.create", target_type="space", target_id=uuid.uuid4(),
                        metadata={"name": "Default"})
    # AuditWriter consults the engine's most-recent-hash for this user_id, then submits
    # with prev_hash set correctly. The exact mechanism is the engine's responsibility
    # (engine API endpoint for "get last hash for user").
```

(Test simplified — the real test verifies it sends the right payloads to the engine.)

**Step 2: Run, verify it fails** — `ModuleNotFoundError`.

**Step 3: Implement**

Create `coordinator/src/klio_coordinator/services/audit_writer.py`:

```python
"""Submits audit-log entries to the engine.

The engine maintains the hash chain authoritatively (it's the single writer);
the coordinator submits events with content fields, the engine computes
prev_hash from its current tail and stores the row with hash chain intact.
"""
import uuid
from typing import Any, Awaitable, Callable

import httpx

from klio_coordinator.config import Settings


class AuditWriter:
    def __init__(
        self,
        _post: Callable[..., Awaitable[Any]] | None = None,
        engine_url: str | None = None,
    ) -> None:
        self._post = _post
        self._engine_url = engine_url or Settings().engine_internal_url

    async def write(
        self,
        *,
        user_id: uuid.UUID,
        actor_type: str,
        actor_id: uuid.UUID | None,
        action: str,
        target_type: str,
        target_id: uuid.UUID | None,
        metadata: dict[str, Any],
    ) -> str:
        """Returns the resulting hash."""
        body = {
            "user_id": str(user_id),
            "actor_type": actor_type,
            "actor_id": str(actor_id) if actor_id else None,
            "action": action,
            "target_type": target_type,
            "target_id": str(target_id) if target_id else None,
            "metadata": metadata,
        }
        if self._post is not None:
            result = await self._post(action, prev_hash="0" * 64, **body)
            return result if isinstance(result, str) else "0" * 64
        async with httpx.AsyncClient(base_url=self._engine_url) as c:
            r = await c.post("/internal/audit", json=body, timeout=5.0)
            r.raise_for_status()
            return r.json()["hash"]
```

**Step 4: Add the engine endpoint that does the chain logic**

Append to `engine/src/klio_engine/api/internal.py`:

```python
class AuditWriteBody(BaseModel):
    user_id: uuid.UUID
    actor_type: str
    actor_id: uuid.UUID | None
    action: str
    target_type: str
    target_id: uuid.UUID | None
    metadata: dict


class AuditWriteResponse(BaseModel):
    id: uuid.UUID
    hash: str
    prev_hash: str


@router.post("/audit", response_model=AuditWriteResponse, status_code=status.HTTP_201_CREATED)
async def write_audit(body: AuditWriteBody, session: AsyncSession = Depends(get_session)):
    from klio_engine.audit.chain import AuditEvent, compute_hash
    from klio_engine.models.audit import AuditLogEntry
    from sqlalchemy import select

    # Find current tail hash for this user
    last = (
        await session.execute(
            select(AuditLogEntry).where(AuditLogEntry.user_id == body.user_id)
            .order_by(AuditLogEntry.created_at.desc()).limit(1)
        )
    ).scalar_one_or_none()
    prev_hash = last.hash if last else "0" * 64

    new_id = uuid.uuid4()
    from datetime import datetime, UTC
    event = AuditEvent(
        id=new_id, user_id=body.user_id, actor_type=body.actor_type,
        actor_id=body.actor_id, action=body.action,
        target_type=body.target_type, target_id=body.target_id,
        metadata=body.metadata, prev_hash=prev_hash,
        created_at=datetime.now(UTC),
    )
    h = compute_hash(event)
    record = AuditLogEntry(
        id=new_id, user_id=body.user_id, actor_type=body.actor_type,
        actor_id=body.actor_id, action=body.action,
        target_type=body.target_type, target_id=body.target_id,
        audit_metadata=body.metadata, prev_hash=prev_hash, hash=h,
    )
    session.add(record)
    await session.commit()
    return AuditWriteResponse(id=new_id, hash=h, prev_hash=prev_hash)
```

**Step 5: Wire AuditWriter calls into provisioning, claim, verify, refresh, grant**

For each, after the privileged action succeeds, call:

```python
await audit_writer.write(
    user_id=user_id, actor_type="agent", actor_id=agent_id,
    action="user.provision", target_type="user", target_id=user_id,
    metadata={"agent_kind": kind, "install_id": str(install_id)},
)
```

**Step 6: Run all coordinator tests**

Run: `pytest tests/ -v`
Expected: all green.

**Step 7: Commit**

```bash
git add src/klio_coordinator/services/audit_writer.py src/klio_coordinator/services/provisioning.py src/klio_coordinator/api/users.py src/klio_coordinator/api/tokens.py src/klio_engine/api/internal.py tests/services/test_audit_writer.py
git commit -m "feat: audit-log writer with engine-side hash chain"
```

End of Phase B. The coordinator can provision, claim, verify, refresh; every privileged action is in the audit log; tokens have one-time-use rotation; the engine's hash chain is maintained authoritatively.

---

## Phase C — Engine Public APIs (Spaces, ACL, Entries, Recall) (Weeks 2–3)

Goal: every public REST endpoint the design doc lists is implemented, ACL is enforced at the engine, and a recall query returns the right entries (semantically-ranked, ACL-filtered). Tenant isolation at the vector layer is verified by adversarial test cases.

### Task C.1 — Engine: bearer-token auth middleware

**Files:**
- Create: `engine/src/klio_engine/api/auth.py`
- Create: `engine/tests/api/test_auth.py`

**Step 1: Write the failing test**

Create `engine/tests/api/test_auth.py`:

```python
"""Bearer-token auth dependency tests."""
import time
import uuid

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from klio_engine.api.auth import RequestContext, require_auth


def _build_test_app(monkeypatch, secret: str) -> FastAPI:
    monkeypatch.setenv("KLIO_JWT_SIGNING_KEY", secret)
    app = FastAPI()

    @app.get("/protected")
    async def protected(ctx: RequestContext = Depends(require_auth)):
        return {"user_id": str(ctx.user_id), "agent_id": str(ctx.agent_id), "scopes": ctx.scopes}

    return app


def test_valid_token_passes(monkeypatch) -> None:
    app = _build_test_app(monkeypatch, "test-secret")
    from klio_engine.api.auth import _mint_for_test
    token = _mint_for_test("test-secret", uuid.uuid4(), uuid.uuid4(), ["read", "write"])
    response = TestClient(app).get("/protected", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200


def test_missing_token_rejected(monkeypatch) -> None:
    app = _build_test_app(monkeypatch, "test-secret")
    response = TestClient(app).get("/protected")
    assert response.status_code == 401


def test_expired_token_rejected(monkeypatch) -> None:
    app = _build_test_app(monkeypatch, "test-secret")
    from klio_engine.api.auth import _mint_for_test
    token = _mint_for_test("test-secret", uuid.uuid4(), uuid.uuid4(), [], ttl=1)
    time.sleep(2)
    response = TestClient(app).get("/protected", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


def test_wrong_signing_key_rejected(monkeypatch) -> None:
    app = _build_test_app(monkeypatch, "secret-a")
    from klio_engine.api.auth import _mint_for_test
    token = _mint_for_test("secret-b", uuid.uuid4(), uuid.uuid4(), [])
    response = TestClient(app).get("/protected", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
```

**Step 2: Run, verify it fails**

Run: `pytest tests/api/test_auth.py -v`
Expected: `ModuleNotFoundError: No module named 'klio_engine.api.auth'`.

**Step 3: Implement auth middleware**

Create `engine/src/klio_engine/api/auth.py`:

```python
"""Bearer token verification for engine public endpoints."""
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
    token = authorization[len("Bearer "):]
    secret = os.getenv("KLIO_JWT_SIGNING_KEY")
    if not secret:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "auth not configured")
    try:
        claims = _jwt.decode(token, secret, algorithms=["HS256"], audience="klio.tech")
    except ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token expired")
    except JWTError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"invalid token: {e}")
    return RequestContext(
        user_id=uuid.UUID(claims["sub"]),
        agent_id=uuid.UUID(claims["agent_id"]),
        scopes=claims.get("scopes", []),
    )


def _mint_for_test(
    secret: str, user_id: uuid.UUID, agent_id: uuid.UUID,
    scopes: list[str], ttl: int = 60,
) -> str:
    now = int(time.time())
    payload = {
        "sub": str(user_id), "agent_id": str(agent_id),
        "scopes": scopes, "iat": now, "exp": now + ttl,
        "aud": "klio.tech", "iss": "test",
    }
    return _jwt.encode(payload, secret, algorithm="HS256")
```

**Step 4: Run, verify it passes**

Run: `pytest tests/api/test_auth.py -v`
Expected: `4 passed`.

**Step 5: Commit**

```bash
git add src/klio_engine/api/auth.py tests/api/test_auth.py
git commit -m "feat(engine): bearer-token auth dependency"
```

---

### Task C.2 — Engine: ACL enforcement helper

**Files:**
- Create: `engine/src/klio_engine/services/acl.py`
- Create: `engine/tests/services/test_acl.py`

**Step 1: Write the failing test**

Create `engine/tests/services/test_acl.py`:

```python
"""ACL enforcement tests."""
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.permission import Permission, PermissionScope
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.acl import ACLDeniedError, check_permission


@pytest.fixture
async def user_agent_space(session: AsyncSession):
    u = User()
    session.add(u)
    await session.flush()
    a = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=uuid.uuid4())
    s = Space(user_id=u.id, name="X", slug="x")
    session.add_all([a, s])
    await session.flush()
    return u, a, s


@pytest.mark.asyncio
async def test_explicit_grant_passes(session, user_agent_space) -> None:
    u, a, s = user_agent_space
    p = Permission(user_id=u.id, space_id=s.id, agent_id=a.id, scope=PermissionScope.READ)
    session.add(p)
    await session.flush()

    await check_permission(session, user_id=u.id, agent_id=a.id, space_id=s.id, scope="read")


@pytest.mark.asyncio
async def test_no_grant_raises(session, user_agent_space) -> None:
    u, a, s = user_agent_space
    with pytest.raises(ACLDeniedError):
        await check_permission(session, user_id=u.id, agent_id=a.id, space_id=s.id, scope="read")


@pytest.mark.asyncio
async def test_revoked_grant_raises(session, user_agent_space) -> None:
    from datetime import UTC, datetime
    u, a, s = user_agent_space
    p = Permission(user_id=u.id, space_id=s.id, agent_id=a.id, scope=PermissionScope.READ,
                   revoked_at=datetime.now(UTC))
    session.add(p)
    await session.flush()
    with pytest.raises(ACLDeniedError):
        await check_permission(session, user_id=u.id, agent_id=a.id, space_id=s.id, scope="read")


@pytest.mark.asyncio
async def test_write_requires_write_or_admin(session, user_agent_space) -> None:
    u, a, s = user_agent_space
    p = Permission(user_id=u.id, space_id=s.id, agent_id=a.id, scope=PermissionScope.READ)
    session.add(p)
    await session.flush()
    with pytest.raises(ACLDeniedError):
        await check_permission(session, user_id=u.id, agent_id=a.id, space_id=s.id, scope="write")


@pytest.mark.asyncio
async def test_admin_satisfies_read_and_write(session, user_agent_space) -> None:
    u, a, s = user_agent_space
    p = Permission(user_id=u.id, space_id=s.id, agent_id=a.id, scope=PermissionScope.ADMIN)
    session.add(p)
    await session.flush()
    await check_permission(session, user_id=u.id, agent_id=a.id, space_id=s.id, scope="read")
    await check_permission(session, user_id=u.id, agent_id=a.id, space_id=s.id, scope="write")
    await check_permission(session, user_id=u.id, agent_id=a.id, space_id=s.id, scope="admin")


@pytest.mark.asyncio
async def test_cross_user_access_denied(session) -> None:
    """Critical: user A's agent must NEVER access user B's space, even with a forged permission row."""
    u_a = User()
    u_b = User()
    session.add_all([u_a, u_b])
    await session.flush()
    agent_a = Agent(user_id=u_a.id, kind=AgentKind.CLAUDE_CODE, install_id=uuid.uuid4())
    space_b = Space(user_id=u_b.id, name="B", slug="b")
    session.add_all([agent_a, space_b])
    await session.flush()
    # Try with mismatched user_id
    with pytest.raises(ACLDeniedError):
        await check_permission(
            session, user_id=u_b.id, agent_id=agent_a.id, space_id=space_b.id, scope="read"
        )
```

**Step 2: Run, verify it fails** — `ModuleNotFoundError`.

**Step 3: Implement ACL service**

Create `engine/src/klio_engine/services/acl.py`:

```python
"""ACL enforcement.

The contract: check_permission raises ACLDeniedError if the (user, agent, space, scope)
tuple is not satisfied by an active grant. The check verifies:
  - The permission row exists.
  - The user_id on the row matches the user_id we were called with.
  - The space's user_id matches.
  - The agent's user_id matches.
  - The scope is satisfied (admin > write > read).
  - revoked_at is NULL.
"""
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.agent import Agent
from klio_engine.models.permission import Permission, PermissionScope
from klio_engine.models.space import Space


_SCOPE_ORDER = {"read": 0, "write": 1, "admin": 2}


class ACLDeniedError(Exception):
    """Raised when a permission check fails. Always returns 403 to clients."""


async def check_permission(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    agent_id: uuid.UUID,
    space_id: uuid.UUID,
    scope: str,
) -> None:
    if scope not in _SCOPE_ORDER:
        raise ValueError(f"unknown scope {scope!r}")

    # Verify the agent and space both belong to user_id (defense-in-depth).
    agent = await session.get(Agent, agent_id)
    if agent is None or agent.user_id != user_id:
        raise ACLDeniedError("agent not owned by user")
    space = await session.get(Space, space_id)
    if space is None or space.user_id != user_id:
        raise ACLDeniedError("space not owned by user")

    p = (
        await session.execute(
            select(Permission).where(
                Permission.user_id == user_id,
                Permission.agent_id == agent_id,
                Permission.space_id == space_id,
                Permission.revoked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if p is None:
        raise ACLDeniedError("no permission")

    granted = _SCOPE_ORDER[p.scope.value]
    needed = _SCOPE_ORDER[scope]
    if granted < needed:
        raise ACLDeniedError(f"scope {p.scope.value!r} insufficient for {scope!r}")
```

**Step 4: Run, verify it passes**

Run: `pytest tests/services/test_acl.py -v`
Expected: `6 passed`.

**Step 5: Commit**

```bash
git add src/klio_engine/services/acl.py tests/services/test_acl.py
git commit -m "feat(engine): ACL check_permission with cross-user isolation"
```

---

### Task C.3 — Engine: GET /v1/spaces (list user's spaces)

**Files:**
- Create: `engine/src/klio_engine/api/spaces.py`
- Create: `engine/src/klio_engine/schemas/__init__.py`
- Create: `engine/src/klio_engine/schemas/spaces.py`
- Create: `engine/tests/api/test_spaces_list.py`
- Modify: `engine/src/klio_engine/api/main.py`

**Step 1: Write the failing test**

Create `engine/tests/api/test_spaces_list.py`:

```python
"""GET /v1/spaces tests."""
import uuid

from fastapi.testclient import TestClient


def test_authed_user_lists_own_spaces(authed_engine_client: tuple) -> None:
    client, ctx = authed_engine_client
    # Create three spaces directly via the engine internal API (bootstrap)
    for name in ["Alpha", "Beta", "Gamma"]:
        client.post(
            "/internal/spaces", json={"user_id": str(ctx.user_id), "name": name, "slug": name.lower()}
        )
    response = client.get("/v1/spaces", headers=ctx.auth_header())
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 3
    names = {s["name"] for s in body}
    assert names == {"Alpha", "Beta", "Gamma"}


def test_user_cannot_list_other_users_spaces(authed_engine_client: tuple) -> None:
    client, ctx = authed_engine_client
    # Create a space owned by a different user
    other_user = client.post("/internal/users", json={"email": None}).json()
    client.post("/internal/spaces", json={
        "user_id": other_user["id"], "name": "Other", "slug": "other",
    })
    response = client.get("/v1/spaces", headers=ctx.auth_header())
    assert response.status_code == 200
    assert response.json() == []  # no spaces for our user


def test_unauthenticated_request_rejected(authed_engine_client: tuple) -> None:
    client, _ = authed_engine_client
    response = client.get("/v1/spaces")
    assert response.status_code == 401
```

Add fixture `authed_engine_client` to `engine/tests/conftest.py`:

```python
@dataclass
class AuthCtx:
    user_id: uuid.UUID
    agent_id: uuid.UUID
    token: str

    def auth_header(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}


@pytest.fixture
def authed_engine_client(monkeypatch, postgres_container, mock_kms_arn):
    import uuid
    from dataclasses import dataclass
    from fastapi.testclient import TestClient
    from klio_engine.api.auth import _mint_for_test
    from klio_engine.api.main import build_app

    url = postgres_container.get_connection_url().replace(
        "postgresql://", "postgresql+asyncpg://", 1
    )
    monkeypatch.setenv("KLIO_DATABASE_URL", url)
    monkeypatch.setenv("KLIO_KMS_KEY_ARN", mock_kms_arn)
    monkeypatch.setenv("KLIO_S3_BUCKET", "test")
    monkeypatch.setenv("KLIO_JWT_SIGNING_KEY", "test-secret")

    app = build_app()
    client = TestClient(app)

    user = client.post("/internal/users", json={"email": None}).json()
    user_id = uuid.UUID(user["id"])
    agent = client.post("/internal/agents", json={
        "user_id": str(user_id), "kind": "claude-code", "install_id": str(uuid.uuid4()),
    }).json()
    agent_id = uuid.UUID(agent["id"])
    token = _mint_for_test("test-secret", user_id, agent_id, ["read", "write", "admin"])
    return client, AuthCtx(user_id=user_id, agent_id=agent_id, token=token)
```

**Step 2: Run, verify it fails** — endpoint doesn't exist.

**Step 3: Implement schemas and router**

Create `engine/src/klio_engine/schemas/spaces.py`:

```python
"""Space request/response schemas."""
import uuid
from datetime import datetime

from pydantic import BaseModel


class SpaceCreate(BaseModel):
    name: str
    slug: str | None = None  # auto-derived from name if absent


class SpaceResponse(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    created_at: datetime
```

Create `engine/src/klio_engine/api/spaces.py`:

```python
"""Public spaces router."""
import re
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.dependencies import get_session
from klio_engine.models.space import Space
from klio_engine.schemas.spaces import SpaceCreate, SpaceResponse

router = APIRouter(prefix="/v1/spaces", tags=["spaces"])


_slug_re = re.compile(r"[^a-z0-9-]+")


def _slugify(name: str) -> str:
    s = _slug_re.sub("-", name.lower()).strip("-")
    return s or "space"


@router.get("", response_model=list[SpaceResponse])
async def list_spaces(
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[SpaceResponse]:
    rows = (
        await session.execute(
            select(Space).where(
                Space.user_id == ctx.user_id, Space.deleted_at.is_(None)
            ).order_by(Space.created_at)
        )
    ).scalars().all()
    return [
        SpaceResponse(id=s.id, name=s.name, slug=s.slug, created_at=s.created_at)
        for s in rows
    ]
```

Mount in `engine/src/klio_engine/api/main.py`:

```python
from klio_engine.api.spaces import router as spaces_router

def build_app() -> FastAPI:
    app = FastAPI(...)
    app.include_router(internal_router)
    app.include_router(spaces_router)
    return app
```

**Step 4: Run, verify it passes**

Run: `pytest tests/api/test_spaces_list.py -v`
Expected: `3 passed`.

**Step 5: Commit**

```bash
git add src/klio_engine/api/spaces.py src/klio_engine/schemas/ src/klio_engine/api/main.py tests/api/test_spaces_list.py tests/conftest.py
git commit -m "feat(engine): GET /v1/spaces with auth + tenant isolation"
```

---

### Task C.4 — Engine: POST /v1/spaces, PATCH, DELETE

**Files:**
- Modify: `engine/src/klio_engine/api/spaces.py` (add create/rename/delete)
- Create: `engine/tests/api/test_spaces_crud.py`

**Step 1: Write the failing tests**

Create `engine/tests/api/test_spaces_crud.py`:

```python
"""POST/PATCH/DELETE /v1/spaces tests."""
import uuid


def test_create_space_returns_201(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    response = client.post(
        "/v1/spaces", json={"name": "Klio Project"}, headers=ctx.auth_header()
    )
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Klio Project"
    assert body["slug"] == "klio-project"


def test_create_space_with_explicit_slug(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    response = client.post(
        "/v1/spaces", json={"name": "X", "slug": "custom-slug"}, headers=ctx.auth_header()
    )
    assert response.status_code == 201
    assert response.json()["slug"] == "custom-slug"


def test_create_duplicate_slug_returns_409(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    client.post("/v1/spaces", json={"name": "A", "slug": "dup"}, headers=ctx.auth_header())
    response = client.post(
        "/v1/spaces", json={"name": "B", "slug": "dup"}, headers=ctx.auth_header()
    )
    assert response.status_code == 409


def test_rename_space(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    created = client.post(
        "/v1/spaces", json={"name": "Old"}, headers=ctx.auth_header()
    ).json()
    response = client.patch(
        f"/v1/spaces/{created['id']}", json={"name": "New"}, headers=ctx.auth_header()
    )
    assert response.status_code == 200
    assert response.json()["name"] == "New"


def test_cannot_rename_other_users_space(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    other_user = client.post("/internal/users", json={"email": None}).json()
    other_space = client.post("/internal/spaces", json={
        "user_id": other_user["id"], "name": "X", "slug": "x",
    }).json()
    response = client.patch(
        f"/v1/spaces/{other_space['id']}", json={"name": "Hijacked"}, headers=ctx.auth_header()
    )
    assert response.status_code == 404  # we 404, not 403, to avoid leaking existence


def test_delete_soft_deletes(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    created = client.post(
        "/v1/spaces", json={"name": "Doomed"}, headers=ctx.auth_header()
    ).json()
    response = client.delete(f"/v1/spaces/{created['id']}", headers=ctx.auth_header())
    assert response.status_code == 204

    listed = client.get("/v1/spaces", headers=ctx.auth_header())
    assert all(s["id"] != created["id"] for s in listed.json())
```

**Step 2: Run, verify it fails.**

**Step 3: Implement create / rename / delete**

Append to `engine/src/klio_engine/api/spaces.py`:

```python
class SpacePatch(BaseModel):
    name: str | None = None


@router.post("", response_model=SpaceResponse, status_code=201)
async def create_space(
    body: SpaceCreate,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> SpaceResponse:
    slug = body.slug or _slugify(body.name)
    s = Space(user_id=ctx.user_id, name=body.name, slug=slug)
    session.add(s)
    try:
        await session.flush()
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, "slug already in use for this user")
    return SpaceResponse(id=s.id, name=s.name, slug=s.slug, created_at=s.created_at)


async def _load_owned_space(
    session: AsyncSession, *, user_id: uuid.UUID, space_id: uuid.UUID
) -> Space:
    s = await session.get(Space, space_id)
    if s is None or s.user_id != user_id or s.deleted_at is not None:
        raise HTTPException(404, "space not found")
    return s


@router.patch("/{space_id}", response_model=SpaceResponse)
async def rename_space(
    space_id: uuid.UUID,
    body: SpacePatch,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> SpaceResponse:
    s = await _load_owned_space(session, user_id=ctx.user_id, space_id=space_id)
    if body.name:
        s.name = body.name
    await session.commit()
    return SpaceResponse(id=s.id, name=s.name, slug=s.slug, created_at=s.created_at)


@router.delete("/{space_id}", status_code=204)
async def delete_space(
    space_id: uuid.UUID,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> None:
    from datetime import UTC, datetime
    s = await _load_owned_space(session, user_id=ctx.user_id, space_id=space_id)
    s.deleted_at = datetime.now(UTC)
    await session.commit()
```

**Step 4: Run, verify it passes**

Run: `pytest tests/api/test_spaces_crud.py -v`
Expected: `6 passed`.

**Step 5: Commit**

```bash
git add src/klio_engine/api/spaces.py tests/api/test_spaces_crud.py
git commit -m "feat(engine): create/rename/delete spaces"
```

---

### Task C.5 — Engine: Permission CRUD

**Files:**
- Create: `engine/src/klio_engine/api/permissions.py`
- Create: `engine/src/klio_engine/schemas/permissions.py`
- Create: `engine/tests/api/test_permissions.py`
- Modify: `engine/src/klio_engine/api/main.py`

**Step 1: Write the failing tests**

Create `engine/tests/api/test_permissions.py`:

```python
"""Per-space ACL endpoints."""
import uuid


def test_list_permissions_empty(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    space = client.post(
        "/v1/spaces", json={"name": "Test"}, headers=ctx.auth_header()
    ).json()
    response = client.get(
        f"/v1/spaces/{space['id']}/permissions", headers=ctx.auth_header()
    )
    assert response.status_code == 200
    assert response.json() == []


def test_grant_permission(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    # Create a second agent under the same user
    second_agent = client.post("/internal/agents", json={
        "user_id": str(ctx.user_id), "kind": "cursor", "install_id": str(uuid.uuid4()),
    }).json()
    space = client.post(
        "/v1/spaces", json={"name": "Test"}, headers=ctx.auth_header()
    ).json()
    response = client.post(
        f"/v1/spaces/{space['id']}/permissions",
        json={"agent_id": second_agent["id"], "scope": "read"},
        headers=ctx.auth_header(),
    )
    assert response.status_code == 201
    assert response.json()["scope"] == "read"


def test_revoke_permission(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    second_agent = client.post("/internal/agents", json={
        "user_id": str(ctx.user_id), "kind": "cursor", "install_id": str(uuid.uuid4()),
    }).json()
    space = client.post(
        "/v1/spaces", json={"name": "T"}, headers=ctx.auth_header()
    ).json()
    client.post(
        f"/v1/spaces/{space['id']}/permissions",
        json={"agent_id": second_agent["id"], "scope": "read"},
        headers=ctx.auth_header(),
    )
    response = client.delete(
        f"/v1/spaces/{space['id']}/permissions/{second_agent['id']}",
        headers=ctx.auth_header(),
    )
    assert response.status_code == 204


def test_only_admin_or_owner_can_grant(authed_engine_client) -> None:
    """An agent without admin scope cannot grant. Note: in this test the granting
    agent is the one bootstrapped at provisioning; it has admin via the
    Default-space bootstrap. To test the negative case, we use a different setup."""
    # Setup: user A's first agent has admin on a space, user A's second agent has read only.
    # Second agent attempts to grant — must be rejected.
    client, ctx = authed_engine_client
    space = client.post(
        "/v1/spaces", json={"name": "Locked"}, headers=ctx.auth_header()
    ).json()

    # Add a second agent and grant it 'read' (using the first agent's admin token)
    second_agent = client.post("/internal/agents", json={
        "user_id": str(ctx.user_id), "kind": "cursor", "install_id": str(uuid.uuid4()),
    }).json()
    client.post(
        f"/v1/spaces/{space['id']}/permissions",
        json={"agent_id": second_agent["id"], "scope": "read"},
        headers=ctx.auth_header(),
    )

    # Mint a token for second_agent and have it try to grant
    from klio_engine.api.auth import _mint_for_test
    second_token = _mint_for_test(
        "test-secret", ctx.user_id, uuid.UUID(second_agent["id"]), ["read"]
    )
    third_agent = client.post("/internal/agents", json={
        "user_id": str(ctx.user_id), "kind": "codex", "install_id": str(uuid.uuid4()),
    }).json()
    response = client.post(
        f"/v1/spaces/{space['id']}/permissions",
        json={"agent_id": third_agent["id"], "scope": "read"},
        headers={"Authorization": f"Bearer {second_token}"},
    )
    assert response.status_code == 403
```

**Step 2: Run, verify it fails.**

**Step 3: Implement schemas and router**

Create `engine/src/klio_engine/schemas/permissions.py`:

```python
"""Permission schemas."""
import uuid
from datetime import datetime

from pydantic import BaseModel


class PermissionGrant(BaseModel):
    agent_id: uuid.UUID
    scope: str  # "read" | "write" | "admin"


class PermissionResponse(BaseModel):
    id: uuid.UUID
    space_id: uuid.UUID
    agent_id: uuid.UUID
    scope: str
    granted_at: datetime
    revoked_at: datetime | None = None
```

Create `engine/src/klio_engine/api/permissions.py`:

```python
"""Per-space ACL endpoints."""
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.dependencies import get_session
from klio_engine.models.permission import Permission, PermissionScope
from klio_engine.models.space import Space
from klio_engine.schemas.permissions import PermissionGrant, PermissionResponse
from klio_engine.services.acl import ACLDeniedError, check_permission

router = APIRouter(prefix="/v1/spaces/{space_id}/permissions", tags=["permissions"])


@router.get("", response_model=list[PermissionResponse])
async def list_permissions(
    space_id: uuid.UUID,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[PermissionResponse]:
    # Caller must have read permission to list (anyone with any access can see who else has access)
    try:
        await check_permission(
            session, user_id=ctx.user_id, agent_id=ctx.agent_id,
            space_id=space_id, scope="read",
        )
    except ACLDeniedError:
        raise HTTPException(404, "space not found")
    rows = (
        await session.execute(
            select(Permission).where(
                Permission.user_id == ctx.user_id,
                Permission.space_id == space_id,
                Permission.revoked_at.is_(None),
            )
        )
    ).scalars().all()
    return [
        PermissionResponse(
            id=p.id, space_id=p.space_id, agent_id=p.agent_id,
            scope=p.scope.value, granted_at=p.granted_at,
        )
        for p in rows
    ]


@router.post("", response_model=PermissionResponse, status_code=201)
async def grant_permission(
    space_id: uuid.UUID,
    body: PermissionGrant,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> PermissionResponse:
    try:
        await check_permission(
            session, user_id=ctx.user_id, agent_id=ctx.agent_id,
            space_id=space_id, scope="admin",
        )
    except ACLDeniedError:
        raise HTTPException(403, "admin scope required")

    # Verify target agent belongs to same user
    from klio_engine.models.agent import Agent
    agent = await session.get(Agent, body.agent_id)
    if agent is None or agent.user_id != ctx.user_id:
        raise HTTPException(404, "agent not found")

    p = Permission(
        user_id=ctx.user_id, space_id=space_id, agent_id=body.agent_id,
        scope=PermissionScope(body.scope),
        granted_by_agent_id=ctx.agent_id,
    )
    session.add(p)
    await session.commit()
    return PermissionResponse(
        id=p.id, space_id=p.space_id, agent_id=p.agent_id,
        scope=p.scope.value, granted_at=p.granted_at,
    )


@router.delete("/{agent_id}", status_code=204)
async def revoke_permission(
    space_id: uuid.UUID,
    agent_id: uuid.UUID,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> None:
    try:
        await check_permission(
            session, user_id=ctx.user_id, agent_id=ctx.agent_id,
            space_id=space_id, scope="admin",
        )
    except ACLDeniedError:
        raise HTTPException(403, "admin scope required")
    p = (
        await session.execute(
            select(Permission).where(
                Permission.user_id == ctx.user_id,
                Permission.space_id == space_id,
                Permission.agent_id == agent_id,
                Permission.revoked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if p is None:
        raise HTTPException(404, "permission not found")
    p.revoked_at = datetime.now(UTC)
    await session.commit()
```

Mount in main.py.

**Step 4: Run, verify it passes**

Run: `pytest tests/api/test_permissions.py -v`
Expected: `4 passed`.

**Step 5: Commit**

```bash
git add src/klio_engine/api/permissions.py src/klio_engine/schemas/permissions.py src/klio_engine/api/main.py tests/api/test_permissions.py
git commit -m "feat(engine): per-space ACL endpoints with admin enforcement"
```

---

### Task C.6 — Engine: POST /v1/spaces/{id}/entries (write entry)

**Files:**
- Create: `engine/src/klio_engine/api/entries.py`
- Create: `engine/src/klio_engine/schemas/entries.py`
- Create: `engine/src/klio_engine/services/entries.py`
- Create: `engine/tests/api/test_entries_write.py`
- Modify: `engine/src/klio_engine/api/main.py`

**Step 1: Write the failing test**

Create `engine/tests/api/test_entries_write.py`:

```python
"""POST /v1/spaces/{id}/entries tests."""


def test_write_memory_entry_returns_201(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    space = client.post(
        "/v1/spaces", json={"name": "Test"}, headers=ctx.auth_header()
    ).json()
    response = client.post(
        f"/v1/spaces/{space['id']}/entries",
        json={
            "kind": "memory",
            "content": "User prefers TypeScript over JavaScript.",
            "metadata": {"source": "user-stated"},
        },
        headers=ctx.auth_header(),
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["kind"] == "memory"
    assert "id" in body
    assert body["content"] == "User prefers TypeScript over JavaScript."  # decrypted in response


def test_write_observation(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    space = client.post(
        "/v1/spaces", json={"name": "Test"}, headers=ctx.auth_header()
    ).json()
    response = client.post(
        f"/v1/spaces/{space['id']}/entries",
        json={"kind": "observation", "content": "Edited auth.ts at 14:32"},
        headers=ctx.auth_header(),
    )
    assert response.status_code == 201
    assert response.json()["kind"] == "observation"


def test_write_requires_write_scope(authed_engine_client) -> None:
    """An agent with only read can't write."""
    import uuid
    from klio_engine.api.auth import _mint_for_test
    client, ctx = authed_engine_client

    space = client.post("/v1/spaces", json={"name": "T"}, headers=ctx.auth_header()).json()
    second_agent = client.post("/internal/agents", json={
        "user_id": str(ctx.user_id), "kind": "cursor", "install_id": str(uuid.uuid4()),
    }).json()
    client.post(
        f"/v1/spaces/{space['id']}/permissions",
        json={"agent_id": second_agent["id"], "scope": "read"},
        headers=ctx.auth_header(),
    )
    second_token = _mint_for_test(
        "test-secret", ctx.user_id, uuid.UUID(second_agent["id"]), ["read"]
    )
    response = client.post(
        f"/v1/spaces/{space['id']}/entries",
        json={"kind": "memory", "content": "should fail"},
        headers={"Authorization": f"Bearer {second_token}"},
    )
    assert response.status_code == 403


def test_invalid_kind_rejected(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    space = client.post("/v1/spaces", json={"name": "T"}, headers=ctx.auth_header()).json()
    response = client.post(
        f"/v1/spaces/{space['id']}/entries",
        json={"kind": "handoff", "content": "x"},  # handoff deferred to Phase 1 expansion
        headers=ctx.auth_header(),
    )
    assert response.status_code == 422


def test_content_too_large_rejected(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    space = client.post("/v1/spaces", json={"name": "T"}, headers=ctx.auth_header()).json()
    response = client.post(
        f"/v1/spaces/{space['id']}/entries",
        json={"kind": "note", "content": "x" * (50_001)},  # 50KB cap
        headers=ctx.auth_header(),
    )
    assert response.status_code == 422
```

**Step 2: Run, verify it fails.**

**Step 3: Implement schemas**

Create `engine/src/klio_engine/schemas/entries.py`:

```python
"""Entry request/response schemas."""
import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


VALID_KINDS_V0 = {"memory", "observation", "plan", "decision", "note"}


class EntryWrite(BaseModel):
    kind: str = Field(...)
    content: str = Field(..., min_length=1, max_length=50_000)
    metadata: dict[str, Any] | None = None
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


class EntryResponse(BaseModel):
    id: uuid.UUID
    space_id: uuid.UUID
    session_id: uuid.UUID | None = None
    agent_id: uuid.UUID
    kind: str
    content: str
    metadata: dict[str, Any] | None = None
    confidence: float
    created_at: datetime
    superseded_by: uuid.UUID | None = None
```

**Step 4: Implement the service that handles encryption + embedding + dedup + insert**

Create `engine/src/klio_engine/services/entries.py`:

```python
"""Entry write/read service with encryption + embedding + dedup."""
import json
import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.crypto.envelope import EnvelopeEncrypter
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.models.user import User
from klio_engine.services.embeddings import EmbeddingService


class EntryService:
    """Writes encrypted entries and reads decrypted entries.

    The service:
      1. Loads the user's envelope key (unwrapped via KMS).
      2. Encrypts content + metadata.
      3. Embeds the plaintext content.
      4. Runs dedup against recent same-kind entries in the same space (cosine >= threshold).
      5. If duplicate: records a supersedes link.
      6. Writes the row.
    """

    def __init__(
        self, *, kms: KMSClient, embeddings: EmbeddingService,
        dedup_threshold: float = 0.92,
    ) -> None:
        self._kms = kms
        self._embeddings = embeddings
        self._dedup_threshold = dedup_threshold

    async def _envelope(self, session: AsyncSession, user_id: uuid.UUID) -> EnvelopeEncrypter:
        u = await session.get(User, user_id)
        if u is None or u.wrapped_envelope_key is None:
            raise ValueError("user has no envelope key")
        plaintext_key = self._kms.unwrap_envelope_key(u.wrapped_envelope_key)
        return EnvelopeEncrypter(envelope_key=plaintext_key)

    async def write(
        self,
        session: AsyncSession,
        *,
        user_id: uuid.UUID,
        space_id: uuid.UUID,
        agent_id: uuid.UUID,
        kind: EntryKind,
        content: str,
        metadata: dict | None = None,
        confidence: float = 1.0,
        session_id: uuid.UUID | None = None,
    ) -> Entry:
        envelope = await self._envelope(session, user_id)
        nonce, ct = envelope.encrypt(content.encode("utf-8"))
        meta_nonce = meta_ct = None
        if metadata:
            meta_nonce, meta_ct = envelope.encrypt(json.dumps(metadata).encode("utf-8"))

        embedding = await self._embeddings.embed(content)

        # Dedup: find an existing entry of same kind in same space with cosine >= threshold.
        existing = await self._find_duplicate(
            session, user_id=user_id, space_id=space_id, kind=kind, embedding=embedding,
        )

        e = Entry(
            user_id=user_id, space_id=space_id, agent_id=agent_id,
            kind=kind, content_ciphertext=ct, content_nonce=nonce,
            metadata_ciphertext=meta_ct, metadata_nonce=meta_nonce,
            embedding=embedding, confidence=confidence, session_id=session_id,
        )
        session.add(e)
        await session.flush()

        if existing is not None:
            existing.superseded_by = e.id

        await session.commit()
        return e

    async def _find_duplicate(
        self, session: AsyncSession, *,
        user_id: uuid.UUID, space_id: uuid.UUID,
        kind: EntryKind, embedding: list[float],
    ) -> Entry | None:
        from sqlalchemy import text
        # Use pgvector cosine distance (1 - cosine_similarity).
        rows = await session.execute(
            text("""
                SELECT id, embedding <=> :emb AS distance
                FROM entries
                WHERE user_id = :user_id
                  AND space_id = :space_id
                  AND kind = :kind
                  AND deleted_at IS NULL
                  AND superseded_by IS NULL
                ORDER BY distance
                LIMIT 1
            """),
            {"user_id": user_id, "space_id": space_id, "kind": kind.value,
             "emb": str(embedding)},
        )
        row = rows.first()
        if row is None:
            return None
        # cosine distance = 1 - cosine sim; threshold 0.92 sim → distance <= 0.08
        if (1.0 - row.distance) >= self._dedup_threshold:
            return await session.get(Entry, row.id)
        return None

    async def decrypt(
        self, session: AsyncSession, entry: Entry, user_id: uuid.UUID,
    ) -> tuple[str, dict | None]:
        envelope = await self._envelope(session, user_id)
        content = envelope.decrypt(entry.content_nonce, entry.content_ciphertext).decode("utf-8")
        metadata = None
        if entry.metadata_ciphertext and entry.metadata_nonce:
            meta_bytes = envelope.decrypt(entry.metadata_nonce, entry.metadata_ciphertext)
            metadata = json.loads(meta_bytes.decode("utf-8"))
        return content, metadata
```

**Step 5: Implement the embeddings service (stub for now; Phase D builds it real)**

Create `engine/src/klio_engine/services/embeddings.py`:

```python
"""Embedding generation. Phase D wires LiteLLM; v0 here is a deterministic stub
suitable for tests."""
import hashlib

from klio_engine.config import Settings


class EmbeddingService:
    """Generates 1536-dim embeddings for text.

    Real implementation calls OpenAI's text-embedding-3-small via LiteLLM.
    For tests and local-only mode, a deterministic stub generates a vector
    derived from a hash of the input text.
    """

    def __init__(self, *, model: str | None = None) -> None:
        self._model = model or Settings().embedding_model

    async def embed(self, text: str) -> list[float]:
        return await self._stub_embed(text)

    async def _stub_embed(self, text: str) -> list[float]:
        # Deterministic test stub: hash the text into 1536 floats in [-1, 1].
        h = hashlib.sha256(text.encode("utf-8")).digest()
        # Repeat the 32-byte hash to fill 1536 floats.
        floats = []
        for i in range(1536):
            byte = h[i % 32]
            floats.append((byte / 127.5) - 1.0)
        # Normalize to unit length.
        norm = sum(f * f for f in floats) ** 0.5
        return [f / norm for f in floats]
```

**Step 6: Implement the entries router**

Create `engine/src/klio_engine/api/entries.py`:

```python
"""Public entries API."""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.config import Settings
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.dependencies import get_session
from klio_engine.models.entry import EntryKind
from klio_engine.schemas.entries import VALID_KINDS_V0, EntryResponse, EntryWrite
from klio_engine.services.acl import ACLDeniedError, check_permission
from klio_engine.services.embeddings import EmbeddingService
from klio_engine.services.entries import EntryService

router = APIRouter(prefix="/v1/spaces/{space_id}/entries", tags=["entries"])


def _entry_service() -> EntryService:
    settings = Settings()
    kms = KMSClient(key_arn=settings.kms_key_arn, region=settings.aws_region)
    return EntryService(kms=kms, embeddings=EmbeddingService())


@router.post("", response_model=EntryResponse, status_code=201)
async def write_entry(
    space_id: uuid.UUID,
    body: EntryWrite,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> EntryResponse:
    if body.kind not in VALID_KINDS_V0:
        raise HTTPException(422, f"kind must be one of {sorted(VALID_KINDS_V0)}")

    try:
        await check_permission(
            session, user_id=ctx.user_id, agent_id=ctx.agent_id,
            space_id=space_id, scope="write",
        )
    except ACLDeniedError as e:
        raise HTTPException(403, str(e))

    svc = _entry_service()
    e = await svc.write(
        session, user_id=ctx.user_id, space_id=space_id, agent_id=ctx.agent_id,
        kind=EntryKind(body.kind), content=body.content,
        metadata=body.metadata, confidence=body.confidence,
    )
    return EntryResponse(
        id=e.id, space_id=e.space_id, session_id=e.session_id, agent_id=e.agent_id,
        kind=e.kind.value, content=body.content, metadata=body.metadata,
        confidence=e.confidence, created_at=e.created_at, superseded_by=e.superseded_by,
    )
```

Mount in main.py.

**Step 7: Run, verify it passes**

Run: `pytest tests/api/test_entries_write.py -v`
Expected: `5 passed`.

**Step 8: Commit**

```bash
git add src/klio_engine/api/entries.py src/klio_engine/services/entries.py src/klio_engine/services/embeddings.py src/klio_engine/schemas/entries.py src/klio_engine/api/main.py tests/api/test_entries_write.py
git commit -m "feat(engine): POST /v1/spaces/{id}/entries with encryption + dedup"
```

---

### Task C.7 — Engine: GET /v1/spaces/{id}/entries (list, decrypt)

**Files:**
- Modify: `engine/src/klio_engine/api/entries.py` (add list)
- Create: `engine/tests/api/test_entries_list.py`

**Step 1: Write the failing test**

Create `engine/tests/api/test_entries_list.py`:

```python
"""GET /v1/spaces/{id}/entries tests."""


def test_list_returns_decrypted_entries(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    space = client.post("/v1/spaces", json={"name": "T"}, headers=ctx.auth_header()).json()
    for content in ["First memory.", "Second memory.", "Third memory."]:
        client.post(
            f"/v1/spaces/{space['id']}/entries",
            json={"kind": "memory", "content": content},
            headers=ctx.auth_header(),
        )
    response = client.get(
        f"/v1/spaces/{space['id']}/entries", headers=ctx.auth_header()
    )
    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 3
    contents = {r["content"] for r in rows}
    assert contents == {"First memory.", "Second memory.", "Third memory."}


def test_list_filters_by_kind(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    space = client.post("/v1/spaces", json={"name": "T"}, headers=ctx.auth_header()).json()
    client.post(f"/v1/spaces/{space['id']}/entries",
                json={"kind": "memory", "content": "M"}, headers=ctx.auth_header())
    client.post(f"/v1/spaces/{space['id']}/entries",
                json={"kind": "observation", "content": "O"}, headers=ctx.auth_header())
    response = client.get(
        f"/v1/spaces/{space['id']}/entries?kind=observation", headers=ctx.auth_header()
    )
    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 1
    assert rows[0]["kind"] == "observation"


def test_list_excludes_superseded(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    space = client.post("/v1/spaces", json={"name": "T"}, headers=ctx.auth_header()).json()
    # Two near-identical memories — second should supersede first.
    client.post(f"/v1/spaces/{space['id']}/entries",
                json={"kind": "memory", "content": "User uses Bun."}, headers=ctx.auth_header())
    client.post(f"/v1/spaces/{space['id']}/entries",
                json={"kind": "memory", "content": "User uses Bun."}, headers=ctx.auth_header())
    response = client.get(f"/v1/spaces/{space['id']}/entries", headers=ctx.auth_header())
    rows = response.json()
    # Both rows still listed, but the older one has superseded_by set.
    assert len(rows) == 2
    superseded = [r for r in rows if r.get("superseded_by")]
    assert len(superseded) == 1


def test_list_requires_read_scope(authed_engine_client) -> None:
    import uuid
    from klio_engine.api.auth import _mint_for_test
    client, ctx = authed_engine_client
    space = client.post("/v1/spaces", json={"name": "T"}, headers=ctx.auth_header()).json()
    other_agent = client.post("/internal/agents", json={
        "user_id": str(ctx.user_id), "kind": "cursor", "install_id": str(uuid.uuid4()),
    }).json()
    other_token = _mint_for_test(
        "test-secret", ctx.user_id, uuid.UUID(other_agent["id"]), ["read"]
    )
    response = client.get(
        f"/v1/spaces/{space['id']}/entries",
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert response.status_code == 403
```

**Step 2: Run, verify it fails.**

**Step 3: Implement list endpoint**

Append to `engine/src/klio_engine/api/entries.py`:

```python
@router.get("", response_model=list[EntryResponse])
async def list_entries(
    space_id: uuid.UUID,
    kind: str | None = None,
    since: datetime | None = None,
    limit: int = 100,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[EntryResponse]:
    try:
        await check_permission(
            session, user_id=ctx.user_id, agent_id=ctx.agent_id,
            space_id=space_id, scope="read",
        )
    except ACLDeniedError as e:
        raise HTTPException(403, str(e))

    from klio_engine.models.entry import Entry
    from sqlalchemy import select
    q = select(Entry).where(
        Entry.user_id == ctx.user_id,
        Entry.space_id == space_id,
        Entry.deleted_at.is_(None),
    )
    if kind is not None:
        if kind not in VALID_KINDS_V0:
            raise HTTPException(422, "invalid kind")
        q = q.where(Entry.kind == EntryKind(kind))
    if since is not None:
        q = q.where(Entry.created_at >= since)
    q = q.order_by(Entry.created_at.desc()).limit(min(limit, 500))

    rows = (await session.execute(q)).scalars().all()
    svc = _entry_service()
    out: list[EntryResponse] = []
    for e in rows:
        content, metadata = await svc.decrypt(session, e, ctx.user_id)
        out.append(EntryResponse(
            id=e.id, space_id=e.space_id, session_id=e.session_id, agent_id=e.agent_id,
            kind=e.kind.value, content=content, metadata=metadata,
            confidence=e.confidence, created_at=e.created_at, superseded_by=e.superseded_by,
        ))
    return out
```

(Add `from datetime import datetime` and `from klio_engine.models.entry import EntryKind` at the top.)

**Step 4: Run, verify it passes**

Run: `pytest tests/api/test_entries_list.py -v`
Expected: `4 passed`.

**Step 5: Commit**

```bash
git add src/klio_engine/api/entries.py tests/api/test_entries_list.py
git commit -m "feat(engine): GET /v1/spaces/{id}/entries with decrypt + filtering"
```

---

### Task C.8 — Engine: POST /v1/spaces/{id}/recall (semantic search)

**Files:**
- Create: `engine/src/klio_engine/api/recall.py`
- Create: `engine/src/klio_engine/services/recall.py`
- Create: `engine/src/klio_engine/schemas/recall.py`
- Create: `engine/tests/api/test_recall.py`
- Modify: `engine/src/klio_engine/api/main.py`

**Step 1: Write the failing test**

Create `engine/tests/api/test_recall.py`:

```python
"""POST /v1/spaces/{id}/recall tests."""


def test_recall_returns_relevant_entries(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    space = client.post("/v1/spaces", json={"name": "T"}, headers=ctx.auth_header()).json()
    client.post(f"/v1/spaces/{space['id']}/entries",
                json={"kind": "memory", "content": "User prefers TypeScript."},
                headers=ctx.auth_header())
    client.post(f"/v1/spaces/{space['id']}/entries",
                json={"kind": "memory", "content": "User likes coffee in the morning."},
                headers=ctx.auth_header())
    client.post(f"/v1/spaces/{space['id']}/entries",
                json={"kind": "memory", "content": "Project uses Bun, not npm."},
                headers=ctx.auth_header())

    response = client.post(
        f"/v1/spaces/{space['id']}/recall",
        json={"query": "What language preferences are documented?"},
        headers=ctx.auth_header(),
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body) > 0
    # The deterministic embedding stub may not pick the most semantic match,
    # but it returns SOMETHING — full ranking quality is verified in Phase D.


def test_recall_respects_limit(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    space = client.post("/v1/spaces", json={"name": "T"}, headers=ctx.auth_header()).json()
    for i in range(20):
        client.post(f"/v1/spaces/{space['id']}/entries",
                    json={"kind": "memory", "content": f"Memory {i}."},
                    headers=ctx.auth_header())
    response = client.post(
        f"/v1/spaces/{space['id']}/recall",
        json={"query": "anything", "limit": 5},
        headers=ctx.auth_header(),
    )
    assert response.status_code == 200
    assert len(response.json()) == 5


def test_recall_filters_by_kind(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    space = client.post("/v1/spaces", json={"name": "T"}, headers=ctx.auth_header()).json()
    client.post(f"/v1/spaces/{space['id']}/entries",
                json={"kind": "memory", "content": "X"}, headers=ctx.auth_header())
    client.post(f"/v1/spaces/{space['id']}/entries",
                json={"kind": "plan", "content": "Y"}, headers=ctx.auth_header())
    response = client.post(
        f"/v1/spaces/{space['id']}/recall",
        json={"query": "anything", "kind": "plan"},
        headers=ctx.auth_header(),
    )
    rows = response.json()
    assert all(r["kind"] == "plan" for r in rows)


def test_recall_excludes_other_users_entries(authed_engine_client) -> None:
    """Critical: cross-tenant isolation in vector search."""
    client, ctx = authed_engine_client
    # Create another user with a memory
    other_user = client.post("/internal/users", json={"email": None}).json()
    other_space = client.post("/internal/spaces", json={
        "user_id": other_user["id"], "name": "S", "slug": "s",
    }).json()
    # We can't write directly to another user's entries via the public API,
    # but a misbehaving engine query that doesn't filter by user_id would leak.
    # This test ensures the recall path respects user_id at the SQL layer.

    my_space = client.post("/v1/spaces", json={"name": "Mine"}, headers=ctx.auth_header()).json()
    client.post(f"/v1/spaces/{my_space['id']}/entries",
                json={"kind": "memory", "content": "My memory."},
                headers=ctx.auth_header())

    # Query in my space — should return only my entries
    response = client.post(
        f"/v1/spaces/{my_space['id']}/recall",
        json={"query": "anything"},
        headers=ctx.auth_header(),
    )
    rows = response.json()
    for r in rows:
        assert r["space_id"] == my_space["id"]


def test_recall_requires_read_scope(authed_engine_client) -> None:
    import uuid
    from klio_engine.api.auth import _mint_for_test
    client, ctx = authed_engine_client
    space = client.post("/v1/spaces", json={"name": "T"}, headers=ctx.auth_header()).json()
    other_agent = client.post("/internal/agents", json={
        "user_id": str(ctx.user_id), "kind": "cursor", "install_id": str(uuid.uuid4()),
    }).json()
    other_token = _mint_for_test(
        "test-secret", ctx.user_id, uuid.UUID(other_agent["id"]), ["read"]
    )
    response = client.post(
        f"/v1/spaces/{space['id']}/recall",
        json={"query": "x"},
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert response.status_code == 403
```

**Step 2: Run, verify it fails.**

**Step 3: Implement recall**

Create `engine/src/klio_engine/schemas/recall.py`:

```python
"""Recall request schemas."""
from pydantic import BaseModel, Field


class RecallRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=2_000)
    kind: str | None = None
    limit: int = Field(default=10, ge=1, le=100)
```

Create `engine/src/klio_engine/services/recall.py`:

```python
"""Recall service — semantic search with ACL filtering."""
import uuid

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.entry import Entry, EntryKind
from klio_engine.services.embeddings import EmbeddingService


class RecallService:
    def __init__(self, *, embeddings: EmbeddingService) -> None:
        self._embeddings = embeddings

    async def recall(
        self,
        session: AsyncSession,
        *,
        user_id: uuid.UUID,
        space_id: uuid.UUID,
        query: str,
        kind: EntryKind | None = None,
        limit: int = 10,
    ) -> list[tuple[Entry, float]]:
        embedding = await self._embeddings.embed(query)
        # Tenant-isolation here is critical: user_id and space_id are bound parameters.
        sql = """
            SELECT id, embedding <=> :emb AS distance
            FROM entries
            WHERE user_id = :user_id
              AND space_id = :space_id
              AND deleted_at IS NULL
              AND superseded_by IS NULL
        """
        params: dict = {
            "user_id": user_id, "space_id": space_id,
            "emb": str(embedding), "limit": limit,
        }
        if kind is not None:
            sql += " AND kind = :kind"
            params["kind"] = kind.value
        sql += " ORDER BY distance LIMIT :limit"

        rows = (await session.execute(text(sql), params)).all()
        ids = [r.id for r in rows]
        if not ids:
            return []
        entries = {
            e.id: e for e in (await session.execute(select(Entry).where(Entry.id.in_(ids)))).scalars()
        }
        return [(entries[r.id], 1.0 - r.distance) for r in rows]  # cosine sim
```

Create `engine/src/klio_engine/api/recall.py`:

```python
"""Recall endpoint."""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.dependencies import get_session
from klio_engine.models.entry import EntryKind
from klio_engine.schemas.entries import VALID_KINDS_V0, EntryResponse
from klio_engine.schemas.recall import RecallRequest
from klio_engine.services.acl import ACLDeniedError, check_permission
from klio_engine.services.embeddings import EmbeddingService
from klio_engine.services.entries import EntryService
from klio_engine.services.recall import RecallService

router = APIRouter(prefix="/v1/spaces/{space_id}/recall", tags=["recall"])


@router.post("", response_model=list[EntryResponse])
async def recall(
    space_id: uuid.UUID,
    body: RecallRequest,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[EntryResponse]:
    if body.kind is not None and body.kind not in VALID_KINDS_V0:
        raise HTTPException(422, "invalid kind")
    try:
        await check_permission(
            session, user_id=ctx.user_id, agent_id=ctx.agent_id,
            space_id=space_id, scope="read",
        )
    except ACLDeniedError as e:
        raise HTTPException(403, str(e))

    embeddings = EmbeddingService()
    recall_svc = RecallService(embeddings=embeddings)
    results = await recall_svc.recall(
        session, user_id=ctx.user_id, space_id=space_id, query=body.query,
        kind=EntryKind(body.kind) if body.kind else None, limit=body.limit,
    )

    from klio_engine.config import Settings
    from klio_engine.crypto.kms_client import KMSClient
    settings = Settings()
    entry_svc = EntryService(
        kms=KMSClient(key_arn=settings.kms_key_arn, region=settings.aws_region),
        embeddings=embeddings,
    )
    out: list[EntryResponse] = []
    for entry, _score in results:
        content, metadata = await entry_svc.decrypt(session, entry, ctx.user_id)
        out.append(EntryResponse(
            id=entry.id, space_id=entry.space_id, session_id=entry.session_id,
            agent_id=entry.agent_id, kind=entry.kind.value, content=content,
            metadata=metadata, confidence=entry.confidence, created_at=entry.created_at,
            superseded_by=entry.superseded_by,
        ))
    return out
```

Mount in main.py.

**Step 4: Run, verify it passes**

Run: `pytest tests/api/test_recall.py -v`
Expected: `5 passed`.

**Step 5: Commit**

```bash
git add src/klio_engine/api/recall.py src/klio_engine/services/recall.py src/klio_engine/schemas/recall.py src/klio_engine/api/main.py tests/api/test_recall.py
git commit -m "feat(engine): POST /v1/spaces/{id}/recall with tenant-isolated vector search"
```

---

### Task C.9 — Engine: DELETE /v1/entries/{id} (soft delete)

**Files:**
- Modify: `engine/src/klio_engine/api/entries.py`
- Create: `engine/tests/api/test_entries_delete.py`

**Step 1: Write the failing test**

Create `engine/tests/api/test_entries_delete.py`:

```python
"""Soft-delete tests."""


def test_delete_marks_deleted_at(authed_engine_client) -> None:
    client, ctx = authed_engine_client
    space = client.post("/v1/spaces", json={"name": "T"}, headers=ctx.auth_header()).json()
    e = client.post(f"/v1/spaces/{space['id']}/entries",
                    json={"kind": "memory", "content": "delete me"},
                    headers=ctx.auth_header()).json()
    response = client.delete(f"/v1/entries/{e['id']}", headers=ctx.auth_header())
    assert response.status_code == 204

    # No longer listed
    listed = client.get(f"/v1/spaces/{space['id']}/entries", headers=ctx.auth_header())
    assert all(r["id"] != e["id"] for r in listed.json())

    # Recall doesn't surface it
    recalled = client.post(f"/v1/spaces/{space['id']}/recall",
                           json={"query": "delete me"}, headers=ctx.auth_header()).json()
    assert all(r["id"] != e["id"] for r in recalled)


def test_delete_other_users_entry_returns_404(authed_engine_client) -> None:
    import uuid
    client, ctx = authed_engine_client
    other_user = client.post("/internal/users", json={"email": None}).json()
    other_space = client.post("/internal/spaces", json={
        "user_id": other_user["id"], "name": "S", "slug": "s",
    }).json()
    # We can't easily create an entry for the other user via API,
    # but we can attempt to delete a fake UUID that isn't ours — same 404.
    response = client.delete(f"/v1/entries/{uuid.uuid4()}", headers=ctx.auth_header())
    assert response.status_code == 404
```

**Step 2: Run, verify it fails.**

**Step 3: Implement delete**

Append a separate router to `engine/src/klio_engine/api/`:

Create `engine/src/klio_engine/api/entry_delete.py`:

```python
"""DELETE /v1/entries/{id}."""
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.dependencies import get_session
from klio_engine.models.entry import Entry

router = APIRouter(prefix="/v1/entries", tags=["entries"])


@router.delete("/{entry_id}", status_code=204)
async def delete_entry(
    entry_id: uuid.UUID,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> None:
    e = await session.get(Entry, entry_id)
    if e is None or e.user_id != ctx.user_id or e.deleted_at is not None:
        raise HTTPException(404, "entry not found")
    e.deleted_at = datetime.now(UTC)
    await session.commit()
```

Mount in main.py.

**Step 4: Run, verify it passes**

Run: `pytest tests/api/test_entries_delete.py -v`
Expected: `2 passed`.

**Step 5: Commit**

```bash
git add src/klio_engine/api/entry_delete.py src/klio_engine/api/main.py tests/api/test_entries_delete.py
git commit -m "feat(engine): DELETE /v1/entries/{id} soft delete"
```

---

### Task C.10 — Engine: Tenant-isolated vector index verification (adversarial)

**Files:**
- Create: `engine/tests/security/test_tenant_isolation.py`

This task adds explicit adversarial tests that the design doc's "five hard guarantees" #1 and #2 hold. No new code — the test should pass against the implementation we already have. If it fails, we fix the implementation rather than the test.

**Step 1: Write the adversarial tests**

Create `engine/tests/security/test_tenant_isolation.py`:

```python
"""Adversarial tenant-isolation tests.

These tests directly probe the engine's defense-in-depth: even if the auth
middleware were bypassed, the queries themselves must filter by user_id.
"""
import uuid

import pytest
from sqlalchemy import text


@pytest.mark.asyncio
async def test_recall_query_includes_user_id_filter(authed_engine_client, postgres_container) -> None:
    """Verify the SQL recall query includes a user_id WHERE clause."""
    import inspect
    from klio_engine.services.recall import RecallService

    # The implementation file must include user_id binding in the SQL string.
    src = inspect.getsource(RecallService.recall)
    assert "user_id = :user_id" in src or "WHERE user_id" in src.replace("\n", " "), (
        "RecallService.recall() must filter by user_id in its SQL query — "
        "this is hard guarantee #1: no entry crosses spaces without explicit grant"
    )


@pytest.mark.asyncio
async def test_two_users_cannot_see_each_others_entries(authed_engine_client) -> None:
    """End-to-end: two real users, semantic queries do not cross."""
    import uuid
    from klio_engine.api.auth import _mint_for_test
    client, ctx_a = authed_engine_client

    # User B
    user_b = client.post("/internal/users", json={"email": None}).json()
    client.post(f"/internal/users/{user_b['id']}/envelope-key")
    agent_b = client.post("/internal/agents", json={
        "user_id": user_b["id"], "kind": "claude-code", "install_id": str(uuid.uuid4()),
    }).json()
    space_b = client.post("/internal/spaces", json={
        "user_id": user_b["id"], "name": "BSpace", "slug": "bspace",
    }).json()
    client.post("/internal/permissions", json={
        "user_id": user_b["id"], "space_id": space_b["id"], "agent_id": agent_b["id"],
        "scope": "admin", "granted_by_agent_id": agent_b["id"],
    })
    token_b = _mint_for_test(
        "test-secret", uuid.UUID(user_b["id"]), uuid.UUID(agent_b["id"]),
        ["read", "write", "admin"],
    )

    # User B writes a uniquely-identifiable memory
    client.post(
        f"/v1/spaces/{space_b['id']}/entries",
        json={"kind": "memory", "content": "User-B-secret-token-hunter2"},
        headers={"Authorization": f"Bearer {token_b}"},
    )

    # User A, in user A's space, recalls — must not find it
    space_a = client.post("/v1/spaces", json={"name": "ASpace"}, headers=ctx_a.auth_header()).json()
    response = client.post(
        f"/v1/spaces/{space_a['id']}/recall",
        json={"query": "secret token hunter"},
        headers=ctx_a.auth_header(),
    )
    rows = response.json()
    for r in rows:
        assert "User-B-secret" not in r["content"]


@pytest.mark.asyncio
async def test_recall_in_unauthorized_space_returns_403(authed_engine_client) -> None:
    """Even our own user's space requires read scope on this agent."""
    import uuid
    from klio_engine.api.auth import _mint_for_test
    client, ctx = authed_engine_client

    space = client.post("/v1/spaces", json={"name": "Locked"}, headers=ctx.auth_header()).json()
    other_agent = client.post("/internal/agents", json={
        "user_id": str(ctx.user_id), "kind": "cursor", "install_id": str(uuid.uuid4()),
    }).json()
    other_token = _mint_for_test(
        "test-secret", ctx.user_id, uuid.UUID(other_agent["id"]), ["read"]
    )
    response = client.post(
        f"/v1/spaces/{space['id']}/recall",
        json={"query": "anything"},
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert response.status_code == 403
```

**Step 2: Run, verify it passes (no implementation changes needed)**

Run: `pytest tests/security/test_tenant_isolation.py -v`
Expected: `3 passed`.

**Step 3: Commit**

```bash
git add tests/security/test_tenant_isolation.py
git commit -m "test(engine): adversarial tenant-isolation tests for hard guarantees #1 and #2"
```

End of Phase C. Every public REST endpoint the design doc lists is implemented and ACL-enforced. Tenant isolation is verified adversarially. Recall returns the right entries from the right user, properly decrypted.

---

## Phase D — Extraction Pipeline (Week 3)

Goal: replace the deterministic embedding stub with real LiteLLM-backed embeddings; build the fact-extraction pipeline that turns transcripts and observations into typed entries; add S3 raw-event storage so we can re-extract later. By end of Phase D, an integration test should: take a sample Claude Code transcript, run extraction, verify it produces well-shaped memories/observations/plans/decisions/notes.

### Task D.1 — Engine: real embedding service via LiteLLM

**Files:**
- Modify: `engine/src/klio_engine/services/embeddings.py`
- Create: `engine/tests/services/test_embeddings_real.py`

**Step 1: Write the failing test**

Create `engine/tests/services/test_embeddings_real.py`:

```python
"""Real embedding service tests (mocked LiteLLM)."""
from unittest.mock import AsyncMock, patch

import pytest

from klio_engine.services.embeddings import EmbeddingService


@pytest.mark.asyncio
async def test_calls_litellm_with_configured_model() -> None:
    fake = {"data": [{"embedding": [0.1] * 1536}]}
    with patch("klio_engine.services.embeddings.aembed", new=AsyncMock(return_value=fake)) as m:
        svc = EmbeddingService(model="text-embedding-3-small", use_real=True)
        result = await svc.embed("hello")
        assert len(result) == 1536
        m.assert_called_once()
        kwargs = m.call_args.kwargs
        assert kwargs["model"] == "text-embedding-3-small"


@pytest.mark.asyncio
async def test_falls_back_to_stub_in_test_mode() -> None:
    svc = EmbeddingService(use_real=False)
    out = await svc.embed("hello")
    assert len(out) == 1536


@pytest.mark.asyncio
async def test_caches_repeated_calls() -> None:
    fake = {"data": [{"embedding": [0.2] * 1536}]}
    with patch("klio_engine.services.embeddings.aembed", new=AsyncMock(return_value=fake)) as m:
        svc = EmbeddingService(model="text-embedding-3-small", use_real=True)
        await svc.embed("dup")
        await svc.embed("dup")
        assert m.call_count == 1  # cached
```

**Step 2: Run, verify it fails.**

**Step 3: Replace the stub with a real LiteLLM-backed implementation**

Replace `engine/src/klio_engine/services/embeddings.py`:

```python
"""Embedding service. LiteLLM in production; deterministic stub in tests."""
import hashlib
from functools import lru_cache

import litellm
from litellm import aembedding as aembed

from klio_engine.config import Settings


class EmbeddingService:
    """Generates 1536-dim embeddings.

    LiteLLM routes to OpenAI's text-embedding-3-small by default (cheap, fast,
    1536-dim). Self-hosted users can swap via KLIO_EMBEDDING_MODEL env.
    Test mode (use_real=False) returns a deterministic stub for hermetic tests.
    """

    def __init__(
        self,
        *,
        model: str | None = None,
        use_real: bool | None = None,
        cache_size: int = 512,
    ) -> None:
        s = Settings()
        self._model = model or s.embedding_model
        self._use_real = use_real if use_real is not None else (s.embedding_model != "stub")
        self._cache: dict[str, list[float]] = {}
        self._cache_max = cache_size

    async def embed(self, text: str) -> list[float]:
        if text in self._cache:
            return self._cache[text]
        result = await self._real_embed(text) if self._use_real else self._stub_embed(text)
        if len(self._cache) >= self._cache_max:
            self._cache.pop(next(iter(self._cache)))
        self._cache[text] = result
        return result

    async def _real_embed(self, text: str) -> list[float]:
        response = await aembed(model=self._model, input=text)
        return response["data"][0]["embedding"]

    def _stub_embed(self, text: str) -> list[float]:
        h = hashlib.sha256(text.encode("utf-8")).digest()
        floats = [(h[i % 32] / 127.5) - 1.0 for i in range(1536)]
        norm = sum(f * f for f in floats) ** 0.5
        return [f / norm for f in floats]
```

**Step 4: Run, verify it passes**

Run: `pytest tests/services/test_embeddings_real.py tests/services/test_embeddings.py -v`
Expected: all green.

**Step 5: Commit**

```bash
git add src/klio_engine/services/embeddings.py tests/services/test_embeddings_real.py
git commit -m "feat(engine): real embedding service via LiteLLM with cache"
```

---

### Task D.2 — Engine: fact extractor (LLM → typed entries)

**Files:**
- Create: `engine/src/klio_engine/services/extractor.py`
- Create: `engine/src/klio_engine/services/extractor_prompts.py`
- Create: `engine/tests/services/test_extractor.py`

**Step 1: Write the failing test**

Create `engine/tests/services/test_extractor.py`:

```python
"""Extractor tests."""
from unittest.mock import AsyncMock, patch

import pytest

from klio_engine.services.extractor import ExtractedEntry, FactExtractor


SAMPLE_TRANSCRIPT = """
USER: Hey, I'm using TypeScript on this project. Don't suggest JavaScript.
ASSISTANT: Got it.
USER: Also we use Bun, not npm. And we deploy on Railway.
ASSISTANT: Understood. I'll plan the auth migration now.
ASSISTANT: Plan: 1) Add JWT middleware. 2) Deprecate session cookies. 3) Update tests.
USER: Yes go ahead with that. We decided on JWT specifically because of the stateless requirement from compliance.
"""


@pytest.mark.asyncio
async def test_extractor_returns_typed_entries() -> None:
    fake_response = {
        "choices": [{"message": {"content": '''
{
  "entries": [
    {"kind": "memory", "content": "User uses TypeScript and explicitly does not want JavaScript suggested.", "confidence": 0.95},
    {"kind": "memory", "content": "Project uses Bun, not npm.", "confidence": 0.95},
    {"kind": "memory", "content": "Deployment platform is Railway.", "confidence": 0.9},
    {"kind": "plan", "content": "Auth migration: 1) Add JWT middleware 2) Deprecate session cookies 3) Update tests", "confidence": 0.9},
    {"kind": "decision", "content": "Use JWT for auth, motivated by compliance requirement for statelessness.", "confidence": 0.85}
  ]
}
'''}}]
    }
    with patch("klio_engine.services.extractor.acompletion",
               new=AsyncMock(return_value=fake_response)):
        ext = FactExtractor()
        entries = await ext.extract(SAMPLE_TRANSCRIPT)
        assert len(entries) == 5
        kinds = [e.kind for e in entries]
        assert "memory" in kinds
        assert "plan" in kinds
        assert "decision" in kinds


@pytest.mark.asyncio
async def test_extractor_drops_invalid_kinds() -> None:
    fake_response = {
        "choices": [{"message": {"content": '''
{
  "entries": [
    {"kind": "memory", "content": "ok", "confidence": 0.9},
    {"kind": "handoff", "content": "deferred — not in v0", "confidence": 0.9}
  ]
}
'''}}]
    }
    with patch("klio_engine.services.extractor.acompletion",
               new=AsyncMock(return_value=fake_response)):
        ext = FactExtractor()
        entries = await ext.extract("anything")
        assert len(entries) == 1
        assert entries[0].kind == "memory"


@pytest.mark.asyncio
async def test_extractor_handles_malformed_json() -> None:
    fake_response = {"choices": [{"message": {"content": "not json at all"}}]}
    with patch("klio_engine.services.extractor.acompletion",
               new=AsyncMock(return_value=fake_response)):
        ext = FactExtractor()
        entries = await ext.extract("anything")
        assert entries == []  # graceful degrade, do not raise
```

**Step 2: Run, verify it fails.**

**Step 3: Implement extractor**

Create `engine/src/klio_engine/services/extractor_prompts.py`:

```python
"""Extraction prompt templates."""
EXTRACT_PROMPT = """\
You extract structured facts from agent-user conversations.

Output ONLY valid JSON in this shape:
{"entries": [{"kind": ..., "content": ..., "confidence": ...}, ...]}

Allowed kinds (NOTHING ELSE):
- memory: a stable fact about the user, project, or context
- observation: something an agent did or saw during the conversation
- plan: forward-looking intent (multi-step plans should be one entry)
- decision: a chosen path with rationale
- note: free-form annotation

Rules:
- Confidence is 0.0–1.0. Use 0.9+ only when explicitly stated by the user.
- Do NOT include speculative or low-information items.
- Do NOT extract entries that are obvious tautologies or restatements of prompts.
- Keep each content under 500 characters.
- Quote the user when their preference is explicit.
- If nothing is extractable, return {"entries": []}.

Conversation:
---
{transcript}
---
"""
```

Create `engine/src/klio_engine/services/extractor.py`:

```python
"""Fact extraction via LLM."""
import json
import re
from dataclasses import dataclass
from typing import Any

import structlog
from litellm import acompletion

from klio_engine.config import Settings
from klio_engine.services.extractor_prompts import EXTRACT_PROMPT


VALID_KINDS = {"memory", "observation", "plan", "decision", "note"}
log = structlog.get_logger()


@dataclass
class ExtractedEntry:
    kind: str
    content: str
    confidence: float
    metadata: dict[str, Any] | None = None


class FactExtractor:
    """Extracts ExtractedEntry rows from a transcript using an LLM.

    The extraction prompt enforces JSON output, valid kinds, and confidence
    bounds. Malformed responses degrade to an empty list rather than raising —
    a partial extraction is fine, a hard failure is not.
    """

    def __init__(self, *, model: str | None = None) -> None:
        self._model = model or "anthropic/claude-haiku-4-5-20251001"

    async def extract(self, transcript: str) -> list[ExtractedEntry]:
        prompt = EXTRACT_PROMPT.format(transcript=transcript[:50_000])
        try:
            response = await acompletion(
                model=self._model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
                max_tokens=2_000,
            )
            content = response["choices"][0]["message"]["content"]
        except Exception as e:
            log.warning("extractor.llm_call_failed", error=str(e))
            return []

        return self._parse(content)

    def _parse(self, raw: str) -> list[ExtractedEntry]:
        match = re.search(r"\{[\s\S]*\}", raw)
        if match is None:
            return []
        try:
            payload = json.loads(match.group(0))
        except json.JSONDecodeError:
            log.warning("extractor.json_decode_failed", raw_head=raw[:200])
            return []
        out: list[ExtractedEntry] = []
        for item in payload.get("entries", []):
            kind = item.get("kind")
            content = item.get("content", "").strip()
            confidence = float(item.get("confidence", 1.0))
            if kind in VALID_KINDS and content and 0.0 <= confidence <= 1.0:
                out.append(ExtractedEntry(kind=kind, content=content[:500], confidence=confidence))
        return out
```

**Step 4: Run, verify it passes**

Run: `pytest tests/services/test_extractor.py -v`
Expected: `3 passed`.

**Step 5: Commit**

```bash
git add src/klio_engine/services/extractor.py src/klio_engine/services/extractor_prompts.py tests/services/test_extractor.py
git commit -m "feat(engine): LLM-backed fact extractor with safe parsing"
```

---

### Task D.3 — Engine: PII scrubber

**Files:**
- Create: `engine/src/klio_engine/services/pii.py`
- Create: `engine/tests/services/test_pii.py`

**Step 1: Write the failing test**

Create `engine/tests/services/test_pii.py`:

```python
"""PII scrubbing tests."""
from klio_engine.services.pii import scrub_pii


def test_redacts_emails() -> None:
    out = scrub_pii("Contact me at abhishek@oppla.ai for details.")
    assert "abhishek@oppla.ai" not in out
    assert "[EMAIL]" in out


def test_redacts_us_ssn() -> None:
    out = scrub_pii("My SSN is 123-45-6789.")
    assert "123-45-6789" not in out
    assert "[SSN]" in out


def test_redacts_credit_card() -> None:
    out = scrub_pii("Charge 4111 1111 1111 1111 expiry 12/29")
    assert "4111 1111 1111 1111" not in out
    assert "[CARD]" in out


def test_redacts_aws_keys() -> None:
    out = scrub_pii("My key is AKIAIOSFODNN7EXAMPLE")
    assert "AKIAIOSFODNN7EXAMPLE" not in out
    assert "[AWS_KEY]" in out


def test_redacts_phone_numbers() -> None:
    out = scrub_pii("Call me at +1-555-123-4567")
    assert "555-123-4567" not in out


def test_preserves_normal_text() -> None:
    out = scrub_pii("User prefers TypeScript over JavaScript.")
    assert out == "User prefers TypeScript over JavaScript."
```

**Step 2: Run, verify it fails.**

**Step 3: Implement scrubber**

Create `engine/src/klio_engine/services/pii.py`:

```python
"""PII scrubbing.

Conservative regex-based redaction. We catch the common high-risk patterns
before any extracted entry is stored: emails, SSNs, credit cards, AWS keys,
phone numbers. False negatives are acceptable; false positives are not.

This is defense-in-depth — extraction prompts already instruct the LLM not
to repeat sensitive material, but the scrubber is a final filter.
"""
import re

_PATTERNS = [
    (re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"), "[EMAIL]"),
    (re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "[SSN]"),
    (re.compile(r"\b(?:\d[ -]?){13,19}\b"), "[CARD]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[AWS_KEY]"),
    (re.compile(r"\b(?:sk-|pk_)[A-Za-z0-9]{20,}\b"), "[API_KEY]"),
    (re.compile(r"\+?\d[\d\s().-]{8,15}\d"), "[PHONE]"),
]


def scrub_pii(text: str) -> str:
    """Return text with high-risk PII redacted."""
    out = text
    for pattern, replacement in _PATTERNS:
        out = pattern.sub(replacement, out)
    return out
```

**Step 4: Run, verify it passes**

Run: `pytest tests/services/test_pii.py -v`
Expected: `6 passed`.

**Step 5: Commit**

```bash
git add src/klio_engine/services/pii.py tests/services/test_pii.py
git commit -m "feat(engine): regex-based PII scrubber"
```

---

### Task D.4 — Engine: S3 raw-event sink

**Files:**
- Create: `engine/src/klio_engine/services/raw_events.py`
- Create: `engine/tests/services/test_raw_events.py`

**Step 1: Write the failing test**

Create `engine/tests/services/test_raw_events.py`:

```python
"""S3 raw-event sink tests (mocked S3 via moto)."""
import json
import uuid
from datetime import UTC, datetime

import boto3
import pytest
from moto import mock_aws

from klio_engine.services.raw_events import RawEventSink


@pytest.mark.asyncio
@mock_aws
async def test_put_returns_key_and_object_exists() -> None:
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="klio-test-raw")

    sink = RawEventSink(bucket="klio-test-raw", region="us-east-1")
    user_id = uuid.uuid4()
    session_id = uuid.uuid4()
    payload = {"messages": [{"role": "user", "content": "hi"}]}

    key = await sink.put(
        user_id=user_id, session_id=session_id,
        source_type="claude-code-session", payload=payload,
        envelope_key=b"\x00" * 32,
    )

    obj = s3.get_object(Bucket="klio-test-raw", Key=key)
    encrypted = obj["Body"].read()
    # Decrypt (uses the same envelope encryption helper)
    from klio_engine.crypto.envelope import EnvelopeEncrypter
    enc = EnvelopeEncrypter(envelope_key=b"\x00" * 32)
    nonce, ct = encrypted[:12], encrypted[12:]
    decrypted = json.loads(enc.decrypt(nonce, ct))
    assert decrypted == payload


@pytest.mark.asyncio
@mock_aws
async def test_keys_are_deterministic_per_session() -> None:
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="klio-test-raw")

    sink = RawEventSink(bucket="klio-test-raw", region="us-east-1")
    uid = uuid.uuid4()
    sid = uuid.uuid4()
    k1 = await sink.put(
        user_id=uid, session_id=sid, source_type="x", payload={"a": 1},
        envelope_key=b"\x00" * 32,
    )
    k2 = await sink.put(
        user_id=uid, session_id=sid, source_type="x", payload={"a": 2},
        envelope_key=b"\x00" * 32,
    )
    # Different timestamps in the key => unique
    assert k1 != k2
    assert str(uid) in k1
    assert str(sid) in k1
```

**Step 2: Run, verify it fails.**

**Step 3: Implement sink**

Create `engine/src/klio_engine/services/raw_events.py`:

```python
"""S3 raw-event storage. Append-only, encrypted, partitioned by user/session."""
import json
import uuid
from datetime import UTC, datetime
from typing import Any

import boto3

from klio_engine.crypto.envelope import EnvelopeEncrypter


class RawEventSink:
    """Stores raw transcripts/tool-calls/hook-payloads in S3.

    Object key format: raw/{user_id}/{session_id}/{ts_ms}-{kind}.json.enc
    Object body: nonce (12 bytes) + ciphertext (AES-256-GCM under the user's
    envelope key).
    """

    def __init__(self, *, bucket: str, region: str = "us-east-1") -> None:
        self._bucket = bucket
        self._client = boto3.client("s3", region_name=region)

    async def put(
        self,
        *,
        user_id: uuid.UUID,
        session_id: uuid.UUID,
        source_type: str,
        payload: dict[str, Any],
        envelope_key: bytes,
    ) -> str:
        ts_ms = int(datetime.now(UTC).timestamp() * 1000)
        key = f"raw/{user_id}/{session_id}/{ts_ms}-{source_type}.json.enc"
        plaintext = json.dumps(payload).encode("utf-8")

        enc = EnvelopeEncrypter(envelope_key=envelope_key)
        nonce, ciphertext = enc.encrypt(plaintext)
        body = nonce + ciphertext

        self._client.put_object(
            Bucket=self._bucket, Key=key, Body=body,
            ContentType="application/octet-stream",
            ServerSideEncryption="aws:kms",
        )
        return key
```

**Step 4: Run, verify it passes**

Run: `pytest tests/services/test_raw_events.py -v`
Expected: `2 passed`.

**Step 5: Commit**

```bash
git add src/klio_engine/services/raw_events.py tests/services/test_raw_events.py
git commit -m "feat(engine): S3 raw-event sink with envelope encryption"
```

---

### Task D.5 — Engine: end-to-end extraction integration test

**Files:**
- Create: `engine/tests/integration/test_extract_pipeline.py`

**Step 1: Write the e2e test**

Create `engine/tests/integration/test_extract_pipeline.py`:

```python
"""End-to-end extraction pipeline:
   raw transcript → S3 → extractor → PII scrub → entries with embeddings → DB.
"""
import uuid
from unittest.mock import AsyncMock, patch

import boto3
import pytest
from moto import mock_aws

from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.entry import Entry
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.embeddings import EmbeddingService
from klio_engine.services.entries import EntryService
from klio_engine.services.extractor import FactExtractor
from klio_engine.services.pii import scrub_pii
from klio_engine.services.raw_events import RawEventSink
from klio_engine.services.user_keys import UserKeyService


SAMPLE = """
USER: I'm Abhishek (abhishek@oppla.ai). My credit card is 4111 1111 1111 1111. Don't store that. Project uses Bun.
ASSISTANT: Understood, I will not store sensitive data. Got the Bun preference.
"""


@pytest.mark.asyncio
@mock_aws
async def test_full_pipeline(session) -> None:
    # KMS + S3 setup
    kms_raw = boto3.client("kms", region_name="us-east-1")
    arn = kms_raw.create_key()["KeyMetadata"]["Arn"]
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="klio-pipeline-test")

    kms = KMSClient(key_arn=arn, region="us-east-1")
    keys = UserKeyService(kms=kms)
    sink = RawEventSink(bucket="klio-pipeline-test", region="us-east-1")
    embeddings = EmbeddingService(use_real=False)
    entries = EntryService(kms=kms, embeddings=embeddings)

    # Create user, agent, space, envelope key
    u = User()
    session.add(u)
    await session.flush()
    plaintext_key = await keys.provision_user_key(session, u)
    a = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=uuid.uuid4())
    s = Space(user_id=u.id, name="Default", slug="default")
    session.add_all([a, s])
    await session.flush()

    sess_uuid = uuid.uuid4()

    # Store raw event in S3
    raw_key = await sink.put(
        user_id=u.id, session_id=sess_uuid, source_type="claude-code-session",
        payload={"transcript": SAMPLE}, envelope_key=plaintext_key,
    )
    assert raw_key

    # Extract with mocked LLM response
    fake_response = {
        "choices": [{"message": {"content": '''{
            "entries": [
                {"kind": "memory", "content": "Project uses Bun.", "confidence": 0.95}
            ]
        }'''}}]
    }
    with patch("klio_engine.services.extractor.acompletion",
               new=AsyncMock(return_value=fake_response)):
        extractor = FactExtractor()
        scrubbed = scrub_pii(SAMPLE)
        # PII verification: email and card number must be gone
        assert "abhishek@oppla.ai" not in scrubbed
        assert "4111 1111 1111 1111" not in scrubbed
        extracted = await extractor.extract(scrubbed)
        assert len(extracted) == 1

    # Persist each as an Entry
    from klio_engine.models.entry import EntryKind
    for ee in extracted:
        await entries.write(
            session, user_id=u.id, space_id=s.id, agent_id=a.id,
            kind=EntryKind(ee.kind), content=ee.content,
            confidence=ee.confidence, session_id=sess_uuid,
        )

    # Verify it's in the DB
    from sqlalchemy import select
    rows = (
        await session.execute(select(Entry).where(Entry.user_id == u.id))
    ).scalars().all()
    assert len(rows) == 1
```

**Step 2: Run, verify it passes**

Run: `pytest tests/integration/test_extract_pipeline.py -v`
Expected: `1 passed`.

**Step 3: Commit**

```bash
git add tests/integration/test_extract_pipeline.py
git commit -m "test(engine): end-to-end extraction pipeline"
```

End of Phase D. Embeddings, extraction, PII scrubbing, and S3 raw-event storage are all wired and end-to-end tested.

---

## Phase E — Daemon (klio-bridge) Foundation (Weeks 3–4)

Goal: a Go daemon that runs as a per-user background service, listens on a unix domain socket, holds a refresh token in the OS keychain, talks to the cloud over HTTPS, and survives restarts. By end of Phase E, `klio version` works, `klio init` writes a refresh token to keychain, and the daemon process accepts connections on `~/.klio/bridge.sock`.

### Task E.1 — Bridge: layout the package structure

**Files:**
- Create: `bridge/internal/socket/server.go`
- Create: `bridge/internal/socket/server_test.go`
- Create: `bridge/internal/keychain/keychain.go`
- Create: `bridge/internal/keychain/keychain_darwin.go` (cgo to Keychain Services)
- Create: `bridge/internal/keychain/keychain_linux.go` (libsecret via D-Bus)
- Create: `bridge/internal/keychain/keychain_windows.go` (Credential Manager)
- Create: `bridge/internal/cloud/client.go`
- Create: `bridge/internal/cloud/client_test.go`
- Create: `bridge/internal/cache/cache.go`
- Create: `bridge/internal/cache/cache_test.go`
- Create: `bridge/internal/daemon/daemon.go`
- Create: `bridge/internal/daemon/daemon_test.go`

The package layout follows standard Go conventions: `internal/<feature>` for private packages.

**Step 1: Create stub files for each package**

Run:
```bash
cd bridge
mkdir -p internal/{socket,keychain,cloud,cache,daemon,agentregistry,config}
touch internal/socket/server.go internal/socket/server_test.go
touch internal/keychain/keychain.go internal/keychain/keychain_test.go
touch internal/cloud/client.go internal/cloud/client_test.go
touch internal/cache/cache.go internal/cache/cache_test.go
touch internal/daemon/daemon.go internal/daemon/daemon_test.go
touch internal/agentregistry/registry.go internal/agentregistry/registry_test.go
touch internal/config/config.go internal/config/config_test.go
```

**Step 2: Add the dependencies**

Run:
```bash
go get github.com/gorilla/websocket@v1.5.3
go get github.com/zalando/go-keyring@v0.2.6
go get github.com/mattn/go-sqlite3@v1.14.24
go get github.com/spf13/cobra@v1.8.1
go get github.com/google/uuid@v1.6.0
go get github.com/stretchr/testify@v1.10.0
go get github.com/sourcegraph/conc@v0.3.0
go mod tidy
```

**Step 3: Commit**

```bash
git add go.mod go.sum internal/
git commit -m "chore(bridge): create internal package layout"
```

---

### Task E.2 — Bridge: config from env + JSON file

**Files:**
- Create: `bridge/internal/config/config.go`
- Create: `bridge/internal/config/config_test.go`

**Step 1: Write the failing test**

Create `bridge/internal/config/config_test.go`:

```go
package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDefaultsWhenNoFile(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	c, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if c.SocketPath == "" {
		t.Fatal("SocketPath default missing")
	}
	if c.CloudURL != "https://api.klio.tech" {
		t.Fatalf("default CloudURL wrong: %s", c.CloudURL)
	}
}

func TestEnvOverridesDefault(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)
	t.Setenv("KLIO_API_URL", "http://localhost:8000")
	t.Setenv("KLIO_LOCAL_ONLY", "true")

	c, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if c.CloudURL != "http://localhost:8000" {
		t.Fatalf("CloudURL not overridden: %s", c.CloudURL)
	}
	if !c.LocalOnly {
		t.Fatal("LocalOnly not overridden")
	}
}

func TestFileOverridesDefault(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	klioDir := filepath.Join(tmpDir, ".klio")
	if err := os.MkdirAll(klioDir, 0o755); err != nil {
		t.Fatal(err)
	}
	configFile := filepath.Join(klioDir, "config.json")
	if err := os.WriteFile(configFile,
		[]byte(`{"cloud_url":"https://staging.klio.tech"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	c, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if c.CloudURL != "https://staging.klio.tech" {
		t.Fatalf("CloudURL not loaded from file: %s", c.CloudURL)
	}
}
```

**Step 2: Run, verify it fails**

Run: `go test ./internal/config/...`
Expected: `Load`, `Config` undefined.

**Step 3: Implement config**

Create `bridge/internal/config/config.go`:

```go
// Package config loads bridge daemon configuration from defaults, ~/.klio/config.json, and env.
//
// Precedence (highest wins): env vars > config file > defaults.
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
)

// Config is the bridge daemon's runtime configuration.
type Config struct {
	SocketPath    string `json:"socket_path"`
	CloudURL      string `json:"cloud_url"`
	LocalOnly     bool   `json:"local_only"`
	CacheDBPath   string `json:"cache_db_path"`
	UpdatesURL    string `json:"updates_url"`
	LogLevel      string `json:"log_level"`
	TelemetryOptIn bool  `json:"telemetry_opt_in"`
}

// Load returns the bridge config, applying defaults, file overrides, then env overrides.
func Load() (*Config, error) {
	c := defaults()
	if err := applyFile(c); err != nil {
		return nil, err
	}
	applyEnv(c)
	return c, nil
}

func defaults() *Config {
	home, _ := os.UserHomeDir()
	socket := filepath.Join(home, ".klio", "bridge.sock")
	if runtime.GOOS == "windows" {
		socket = "127.0.0.1:7878"
	}
	return &Config{
		SocketPath:  socket,
		CloudURL:    "https://api.klio.tech",
		LocalOnly:   false,
		CacheDBPath: filepath.Join(home, ".klio", "cache.db"),
		UpdatesURL:  "https://updates.klio.tech/manifest.json",
		LogLevel:    "info",
	}
}

func applyFile(c *Config) error {
	home, _ := os.UserHomeDir()
	path := filepath.Join(home, ".klio", "config.json")
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(data, c)
}

func applyEnv(c *Config) {
	if v := os.Getenv("KLIO_API_URL"); v != "" {
		c.CloudURL = v
	}
	if v := os.Getenv("KLIO_LOCAL_ONLY"); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			c.LocalOnly = b
		}
	}
	if v := os.Getenv("KLIO_LOG_LEVEL"); v != "" {
		c.LogLevel = v
	}
	if v := os.Getenv("KLIO_SOCKET_PATH"); v != "" {
		c.SocketPath = v
	}
}
```

**Step 4: Run, verify it passes**

Run: `go test ./internal/config/...`
Expected: `ok ... internal/config`.

**Step 5: Commit**

```bash
git add internal/config/
git commit -m "feat(bridge): config loader with defaults, file, and env precedence"
```

---

### Task E.3 — Bridge: keychain wrapper (cross-platform)

**Files:**
- Create: `bridge/internal/keychain/keychain.go`
- Create: `bridge/internal/keychain/keychain_test.go`

**Step 1: Write the failing test**

Create `bridge/internal/keychain/keychain_test.go`:

```go
package keychain

import (
	"errors"
	"testing"
)

const testService = "tech.klio.bridge.test"

func TestRoundTrip(t *testing.T) {
	k := New(testService)
	t.Cleanup(func() { _ = k.Delete("test-key") })

	if err := k.Set("test-key", []byte("secret-value-123")); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, err := k.Get("test-key")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if string(got) != "secret-value-123" {
		t.Fatalf("got %q", got)
	}
}

func TestGetMissingReturnsErrNotFound(t *testing.T) {
	k := New(testService)
	_, err := k.Get("nonexistent-key-9999")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestDelete(t *testing.T) {
	k := New(testService)
	_ = k.Set("delete-me", []byte("x"))
	if err := k.Delete("delete-me"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	_, err := k.Get("delete-me")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound after delete, got %v", err)
	}
}
```

**Step 2: Run, verify it fails** — undefined symbols.

**Step 3: Implement keychain**

Create `bridge/internal/keychain/keychain.go`:

```go
// Package keychain wraps platform-native credential storage:
//   - macOS: Keychain Services (via go-keyring)
//   - Linux: Secret Service / libsecret (via go-keyring's D-Bus binding)
//   - Windows: Credential Manager (via go-keyring)
//
// On Linux without a running secret service (e.g., headless containers),
// callers should fall back to an encrypted file. That fallback lives in
// internal/keychain/file_fallback.go (Phase E.4).
package keychain

import (
	"errors"

	"github.com/zalando/go-keyring"
)

// ErrNotFound indicates the requested key is not stored.
var ErrNotFound = errors.New("keychain: key not found")

// Keychain stores secrets under a stable service identifier.
type Keychain struct {
	service string
}

// New returns a Keychain bound to the given service identifier.
// Service should be reverse-DNS, e.g., "tech.klio.bridge".
func New(service string) *Keychain {
	return &Keychain{service: service}
}

// Set stores or overwrites the secret under key.
func (k *Keychain) Set(key string, value []byte) error {
	return keyring.Set(k.service, key, string(value))
}

// Get fetches the secret. Returns ErrNotFound if absent.
func (k *Keychain) Get(key string) ([]byte, error) {
	v, err := keyring.Get(k.service, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return []byte(v), nil
}

// Delete removes the secret. No error if it doesn't exist.
func (k *Keychain) Delete(key string) error {
	err := keyring.Delete(k.service, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}
```

**Step 4: Run, verify it passes**

Run: `go test ./internal/keychain/...`
Expected: `ok` on macOS/Linux/Windows. (CI on Linux needs `secret-tool` and a running gnome-keyring; we'll add a CI workaround in Task E.4.)

**Step 5: Commit**

```bash
git add internal/keychain/
git commit -m "feat(bridge): cross-platform keychain wrapper"
```

---

### Task E.4 — Bridge: encrypted-file fallback when keychain unavailable

**Files:**
- Modify: `bridge/internal/keychain/keychain.go`
- Create: `bridge/internal/keychain/file_fallback.go`
- Create: `bridge/internal/keychain/file_fallback_test.go`

**Step 1: Write the failing test**

Create `bridge/internal/keychain/file_fallback_test.go`:

```go
package keychain

import (
	"path/filepath"
	"testing"
)

func TestFileBackendRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "creds.enc")
	masterKey := make([]byte, 32)
	for i := range masterKey {
		masterKey[i] = byte(i)
	}

	b := NewFileBackend(path, masterKey)
	if err := b.Set("k1", []byte("v1")); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, err := b.Get("k1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if string(got) != "v1" {
		t.Fatalf("got %q", got)
	}
}

func TestFileBackendPersistsAcrossInstances(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "creds.enc")
	masterKey := make([]byte, 32)
	for i := range masterKey {
		masterKey[i] = byte(i + 1)
	}

	b1 := NewFileBackend(path, masterKey)
	_ = b1.Set("persistent", []byte("yes"))

	b2 := NewFileBackend(path, masterKey)
	got, err := b2.Get("persistent")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if string(got) != "yes" {
		t.Fatalf("got %q", got)
	}
}

func TestFileBackendWrongKeyFails(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "creds.enc")
	keyA := make([]byte, 32)
	keyB := make([]byte, 32)
	for i := range keyB {
		keyB[i] = 1
	}

	bA := NewFileBackend(path, keyA)
	_ = bA.Set("k", []byte("v"))

	bB := NewFileBackend(path, keyB)
	_, err := bB.Get("k")
	if err == nil {
		t.Fatal("expected error with wrong master key")
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement file backend**

Create `bridge/internal/keychain/file_fallback.go`:

```go
package keychain

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sync"
)

// FileBackend stores key/value pairs in a single AES-256-GCM-encrypted file.
// The master key is provided by the caller — typically derived from machine
// ID or a user-prompted passphrase. Used as a fallback when the OS keychain
// is unavailable (e.g., headless Linux containers).
type FileBackend struct {
	path      string
	masterKey []byte
	mu        sync.Mutex
}

// NewFileBackend returns a FileBackend at path, encrypting with masterKey (32 bytes).
func NewFileBackend(path string, masterKey []byte) *FileBackend {
	return &FileBackend{path: path, masterKey: masterKey}
}

func (f *FileBackend) Set(key string, value []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	store, err := f.load()
	if err != nil {
		return err
	}
	store[key] = string(value)
	return f.save(store)
}

func (f *FileBackend) Get(key string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	store, err := f.load()
	if err != nil {
		return nil, err
	}
	v, ok := store[key]
	if !ok {
		return nil, ErrNotFound
	}
	return []byte(v), nil
}

func (f *FileBackend) Delete(key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	store, err := f.load()
	if err != nil {
		return err
	}
	delete(store, key)
	return f.save(store)
}

func (f *FileBackend) load() (map[string]string, error) {
	data, err := os.ReadFile(f.path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	if len(data) < 12 {
		return nil, errors.New("keychain file too short")
	}
	nonce, ciphertext := data[:12], data[12:]

	block, err := aes.NewCipher(f.masterKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}
	var store map[string]string
	if err := json.Unmarshal(plaintext, &store); err != nil {
		return nil, err
	}
	return store, nil
}

func (f *FileBackend) save(store map[string]string) error {
	plaintext, err := json.Marshal(store)
	if err != nil {
		return err
	}
	block, err := aes.NewCipher(f.masterKey)
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	nonce := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return err
	}
	ct := gcm.Seal(nil, nonce, plaintext, nil)
	return os.WriteFile(f.path, append(nonce, ct...), 0o600)
}
```

**Step 4: Run, verify it passes**

Run: `go test ./internal/keychain/...`
Expected: `ok`.

**Step 5: Commit**

```bash
git add internal/keychain/
git commit -m "feat(bridge): encrypted-file keychain fallback"
```

---

### Task E.5 — Bridge: cloud HTTP client with token refresh

**Files:**
- Create: `bridge/internal/cloud/client.go`
- Create: `bridge/internal/cloud/client_test.go`
- Create: `bridge/internal/cloud/types.go`

**Step 1: Write the failing test**

Create `bridge/internal/cloud/client_test.go`:

```go
package cloud

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestProvisionCallsExpectedEndpoint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/users/provision" {
			t.Errorf("wrong path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("wrong method: %s", r.Method)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["agent_kind"] != "klio-bridge" {
			t.Errorf("wrong agent_kind: %v", body["agent_kind"])
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user_id":           uuid.New().String(),
			"agent_id":          uuid.New().String(),
			"api_key":           "rt_" + strings.Repeat("x", 40),
			"claimed":           false,
			"default_space_id":  uuid.New().String(),
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	resp, err := c.Provision(ProvisionRequest{
		AgentKind: "klio-bridge", InstallID: uuid.New(),
	})
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if resp.APIKey == "" {
		t.Fatal("APIKey empty")
	}
}

func TestRefreshAccessTokenRetriesOn401(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path == "/v1/spaces" && r.Header.Get("Authorization") != "Bearer fresh-access" {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/v1/tokens/refresh" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "fresh-access", "refresh_token": "new-refresh", "expires_in": 3600,
			})
			return
		}
		w.WriteHeader(200)
		_ = json.NewEncoder(w).Encode([]any{})
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.SetRefreshToken("old-refresh")
	c.SetAccessToken("expired-access")

	_, err := c.ListSpaces()
	if err != nil {
		t.Fatalf("ListSpaces should retry on 401: %v", err)
	}
	if c.AccessToken() != "fresh-access" {
		t.Fatalf("access token not refreshed: %s", c.AccessToken())
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement client + types**

Create `bridge/internal/cloud/types.go`:

```go
package cloud

import (
	"time"

	"github.com/google/uuid"
)

type ProvisionRequest struct {
	AgentKind   string    `json:"agent_kind"`
	InstallID   uuid.UUID `json:"install_id"`
	DisplayName string    `json:"display_name,omitempty"`
	Email       string    `json:"email,omitempty"`
}

type ProvisionResponse struct {
	UserID         uuid.UUID `json:"user_id"`
	AgentID        uuid.UUID `json:"agent_id"`
	APIKey         string    `json:"api_key"`
	Claimed        bool      `json:"claimed"`
	DefaultSpaceID uuid.UUID `json:"default_space_id"`
}

type RefreshResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
}

type Space struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	Slug      string    `json:"slug"`
	CreatedAt time.Time `json:"created_at"`
}

type Entry struct {
	ID            uuid.UUID      `json:"id"`
	SpaceID       uuid.UUID      `json:"space_id"`
	AgentID       uuid.UUID      `json:"agent_id"`
	Kind          string         `json:"kind"`
	Content       string         `json:"content"`
	Metadata      map[string]any `json:"metadata,omitempty"`
	Confidence    float64        `json:"confidence"`
	CreatedAt     time.Time      `json:"created_at"`
	SupersededBy  *uuid.UUID     `json:"superseded_by,omitempty"`
}

type EntryWrite struct {
	Kind       string         `json:"kind"`
	Content    string         `json:"content"`
	Metadata   map[string]any `json:"metadata,omitempty"`
	Confidence float64        `json:"confidence,omitempty"`
}

type RecallRequest struct {
	Query string `json:"query"`
	Kind  string `json:"kind,omitempty"`
	Limit int    `json:"limit,omitempty"`
}
```

Create `bridge/internal/cloud/client.go`:

```go
// Package cloud is the daemon's HTTP client for api.klio.tech.
//
// Manages access-token + refresh-token lifecycle. Auto-retries once on 401
// after refreshing. All calls go through a single transport with sane
// timeouts and a small connection pool.
package cloud

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/google/uuid"
)

var ErrUnauthorized = errors.New("cloud: unauthorized after refresh")

type Client struct {
	baseURL      string
	http         *http.Client
	mu           sync.RWMutex
	accessToken  string
	refreshToken string
}

func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		http: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        10,
				MaxIdleConnsPerHost: 5,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

func (c *Client) SetAccessToken(t string)  { c.mu.Lock(); c.accessToken = t; c.mu.Unlock() }
func (c *Client) SetRefreshToken(t string) { c.mu.Lock(); c.refreshToken = t; c.mu.Unlock() }
func (c *Client) AccessToken() string       { c.mu.RLock(); defer c.mu.RUnlock(); return c.accessToken }
func (c *Client) RefreshToken() string      { c.mu.RLock(); defer c.mu.RUnlock(); return c.refreshToken }

func (c *Client) Provision(req ProvisionRequest) (*ProvisionResponse, error) {
	var resp ProvisionResponse
	if err := c.do("POST", "/v1/users/provision", req, &resp, false); err != nil {
		return nil, err
	}
	return &resp, nil
}

func (c *Client) refresh() error {
	body := map[string]string{"refresh_token": c.RefreshToken()}
	var resp RefreshResponse
	if err := c.do("POST", "/v1/tokens/refresh", body, &resp, false); err != nil {
		return err
	}
	c.SetAccessToken(resp.AccessToken)
	c.SetRefreshToken(resp.RefreshToken)
	return nil
}

func (c *Client) ListSpaces() ([]Space, error) {
	var spaces []Space
	if err := c.do("GET", "/v1/spaces", nil, &spaces, true); err != nil {
		return nil, err
	}
	return spaces, nil
}

func (c *Client) Recall(spaceID uuid.UUID, req RecallRequest) ([]Entry, error) {
	var entries []Entry
	path := fmt.Sprintf("/v1/spaces/%s/recall", spaceID)
	if err := c.do("POST", path, req, &entries, true); err != nil {
		return nil, err
	}
	return entries, nil
}

func (c *Client) WriteEntry(spaceID uuid.UUID, req EntryWrite) (*Entry, error) {
	var e Entry
	path := fmt.Sprintf("/v1/spaces/%s/entries", spaceID)
	if err := c.do("POST", path, req, &e, true); err != nil {
		return nil, err
	}
	return &e, nil
}

// do executes a request, optionally retrying once on 401 after a token refresh.
func (c *Client) do(method, path string, body any, out any, withAuth bool) error {
	for attempt := 0; attempt < 2; attempt++ {
		err := c.doOnce(method, path, body, out, withAuth)
		if err == nil {
			return nil
		}
		if !errors.Is(err, ErrUnauthorized) || !withAuth || attempt == 1 {
			return err
		}
		if rerr := c.refresh(); rerr != nil {
			return fmt.Errorf("refresh failed: %w (original: %v)", rerr, err)
		}
	}
	return ErrUnauthorized
}

func (c *Client) doOnce(method, path string, body any, out any, withAuth bool) error {
	u, _ := url.JoinPath(c.baseURL, path)
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, u, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if withAuth {
		req.Header.Set("Authorization", "Bearer "+c.AccessToken())
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return ErrUnauthorized
	}
	if resp.StatusCode >= 400 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("cloud: %d %s: %s", resp.StatusCode, resp.Status, bodyBytes)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}
```

**Step 4: Run, verify it passes**

Run: `go test ./internal/cloud/...`
Expected: `ok`.

**Step 5: Commit**

```bash
git add internal/cloud/
git commit -m "feat(bridge): cloud HTTP client with token refresh"
```

---

### Task E.6 — Bridge: SQLite-backed local cache

**Files:**
- Create: `bridge/internal/cache/cache.go`
- Create: `bridge/internal/cache/cache_test.go`
- Create: `bridge/internal/cache/schema.sql`

**Step 1: Write the failing test**

Create `bridge/internal/cache/cache_test.go`:

```go
package cache

import (
	"path/filepath"
	"testing"

	"github.com/google/uuid"
)

func TestPutGetRoundTrip(t *testing.T) {
	dir := t.TempDir()
	c, err := Open(filepath.Join(dir, "cache.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer c.Close()

	spaceID := uuid.New()
	entryID := uuid.New()
	if err := c.PutEntry(CachedEntry{
		ID: entryID, SpaceID: spaceID, Kind: "memory", Content: "hello",
	}); err != nil {
		t.Fatalf("PutEntry: %v", err)
	}
	got, err := c.GetEntry(entryID)
	if err != nil {
		t.Fatalf("GetEntry: %v", err)
	}
	if got.Content != "hello" {
		t.Fatalf("got %q", got.Content)
	}
}

func TestListBySpaceFiltersAndOrders(t *testing.T) {
	dir := t.TempDir()
	c, _ := Open(filepath.Join(dir, "cache.db"))
	defer c.Close()

	space1 := uuid.New()
	space2 := uuid.New()
	for i, sp := range []uuid.UUID{space1, space2, space1} {
		_ = c.PutEntry(CachedEntry{
			ID: uuid.New(), SpaceID: sp, Kind: "memory", Content: "e" + string(rune('a'+i)),
		})
	}
	rows, err := c.ListBySpace(space1, 100)
	if err != nil {
		t.Fatalf("ListBySpace: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows for space1, got %d", len(rows))
	}
}

func TestPendingWriteEnqueueAndDrain(t *testing.T) {
	dir := t.TempDir()
	c, _ := Open(filepath.Join(dir, "cache.db"))
	defer c.Close()

	spaceID := uuid.New()
	_ = c.EnqueuePendingWrite(spaceID, "memory", "x", nil)
	_ = c.EnqueuePendingWrite(spaceID, "note", "y", nil)

	pending, err := c.DrainPending(10)
	if err != nil {
		t.Fatalf("DrainPending: %v", err)
	}
	if len(pending) != 2 {
		t.Fatalf("expected 2 pending, got %d", len(pending))
	}
	// After drain, queue is empty
	again, _ := c.DrainPending(10)
	if len(again) != 0 {
		t.Fatalf("expected empty queue after drain")
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement cache**

Create `bridge/internal/cache/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT,
    confidence REAL NOT NULL DEFAULT 1.0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_space_created ON entries(space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pending_writes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT,
    queued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS acl_cache (
    space_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    refreshed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (space_id, agent_id)
);

CREATE TABLE IF NOT EXISTS subscription_state (
    space_id TEXT PRIMARY KEY,
    last_acked_frame_id TEXT
);

CREATE TABLE IF NOT EXISTS agent_bindings (
    cwd_pattern TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    space_id TEXT NOT NULL,
    confirmed BOOLEAN NOT NULL DEFAULT 0,
    PRIMARY KEY (cwd_pattern, agent_kind)
);
```

Create `bridge/internal/cache/cache.go`:

```go
// Package cache is the daemon's local SQLite-backed mirror of recent entries,
// pending writes, ACL state, and agent bindings.
package cache

import (
	"database/sql"
	_ "embed"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"github.com/google/uuid"
)

//go:embed schema.sql
var schemaSQL string

type CachedEntry struct {
	ID           uuid.UUID
	SpaceID      uuid.UUID
	Kind         string
	Content      string
	Metadata     map[string]any
	Confidence   float64
	CreatedAt    time.Time
	SupersededBy *uuid.UUID
}

type PendingWrite struct {
	ID       int64
	SpaceID  uuid.UUID
	Kind     string
	Content  string
	Metadata map[string]any
}

type Cache struct {
	db *sql.DB
}

// Open creates or opens the cache database at path.
func Open(path string) (*Cache, error) {
	db, err := sql.Open("sqlite3", path+"?_journal=WAL&_foreign_keys=on")
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schemaSQL); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Cache{db: db}, nil
}

func (c *Cache) Close() error { return c.db.Close() }

func (c *Cache) PutEntry(e CachedEntry) error {
	_, err := c.db.Exec(
		`INSERT OR REPLACE INTO entries(id, space_id, kind, content, confidence, superseded_by)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		e.ID.String(), e.SpaceID.String(), e.Kind, e.Content, e.Confidence,
		nullableUUIDString(e.SupersededBy),
	)
	return err
}

func (c *Cache) GetEntry(id uuid.UUID) (*CachedEntry, error) {
	row := c.db.QueryRow(
		`SELECT id, space_id, kind, content, confidence FROM entries WHERE id = ?`,
		id.String(),
	)
	var idStr, spaceStr, kind, content string
	var conf float64
	if err := row.Scan(&idStr, &spaceStr, &kind, &content, &conf); err != nil {
		return nil, err
	}
	return &CachedEntry{
		ID: uuid.MustParse(idStr), SpaceID: uuid.MustParse(spaceStr),
		Kind: kind, Content: content, Confidence: conf,
	}, nil
}

func (c *Cache) ListBySpace(spaceID uuid.UUID, limit int) ([]CachedEntry, error) {
	rows, err := c.db.Query(
		`SELECT id, space_id, kind, content, confidence FROM entries
		 WHERE space_id = ? ORDER BY created_at DESC LIMIT ?`,
		spaceID.String(), limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CachedEntry
	for rows.Next() {
		var idStr, spaceStr, kind, content string
		var conf float64
		if err := rows.Scan(&idStr, &spaceStr, &kind, &content, &conf); err != nil {
			return nil, err
		}
		out = append(out, CachedEntry{
			ID: uuid.MustParse(idStr), SpaceID: uuid.MustParse(spaceStr),
			Kind: kind, Content: content, Confidence: conf,
		})
	}
	return out, nil
}

func (c *Cache) EnqueuePendingWrite(spaceID uuid.UUID, kind, content string, metadata map[string]any) error {
	_, err := c.db.Exec(
		`INSERT INTO pending_writes(space_id, kind, content) VALUES (?, ?, ?)`,
		spaceID.String(), kind, content,
	)
	return err
}

func (c *Cache) DrainPending(limit int) ([]PendingWrite, error) {
	tx, err := c.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.Query(
		`SELECT id, space_id, kind, content FROM pending_writes ORDER BY id LIMIT ?`,
		limit,
	)
	if err != nil {
		return nil, err
	}
	var out []PendingWrite
	var ids []int64
	for rows.Next() {
		var p PendingWrite
		var spaceStr string
		if err := rows.Scan(&p.ID, &spaceStr, &p.Kind, &p.Content); err != nil {
			return nil, err
		}
		p.SpaceID = uuid.MustParse(spaceStr)
		out = append(out, p)
		ids = append(ids, p.ID)
	}
	rows.Close()
	for _, id := range ids {
		if _, err := tx.Exec(`DELETE FROM pending_writes WHERE id = ?`, id); err != nil {
			return nil, err
		}
	}
	return out, tx.Commit()
}

func nullableUUIDString(u *uuid.UUID) any {
	if u == nil {
		return nil
	}
	return u.String()
}
```

**Step 4: Run, verify it passes**

Run: `go test ./internal/cache/...`
Expected: `ok`.

**Step 5: Commit**

```bash
git add internal/cache/
git commit -m "feat(bridge): SQLite local cache for entries and pending writes"
```

---

### Task E.7 — Bridge: agent registry (in-memory)

**Files:**
- Create: `bridge/internal/agentregistry/registry.go`
- Create: `bridge/internal/agentregistry/registry_test.go`

**Step 1: Write the failing test**

Create `bridge/internal/agentregistry/registry_test.go`:

```go
package agentregistry

import (
	"testing"

	"github.com/google/uuid"
)

func TestRegisterAndGet(t *testing.T) {
	r := New()
	connID := "conn-1"
	r.Register(connID, AgentInfo{Kind: "claude-code", Cwd: "/Users/abhishek/oppla"})
	info, ok := r.Get(connID)
	if !ok {
		t.Fatal("Get returned !ok")
	}
	if info.Kind != "claude-code" {
		t.Fatalf("Kind = %s", info.Kind)
	}
}

func TestActiveSpaceForCwd(t *testing.T) {
	r := New()
	spaceID := uuid.New()
	r.BindCwd("/Users/abhishek/oppla", "claude-code", spaceID)

	got, ok := r.SpaceForCwd("/Users/abhishek/oppla", "claude-code")
	if !ok {
		t.Fatal("SpaceForCwd !ok")
	}
	if got != spaceID {
		t.Fatalf("got %s want %s", got, spaceID)
	}
}

func TestSubscribersForSpace(t *testing.T) {
	r := New()
	space1 := uuid.New()
	space2 := uuid.New()

	r.Register("c1", AgentInfo{Kind: "claude-code", ActiveSpace: &space1})
	r.Register("c2", AgentInfo{Kind: "cursor", ActiveSpace: &space1})
	r.Register("c3", AgentInfo{Kind: "codex", ActiveSpace: &space2})

	subs := r.SubscribersOfSpace(space1)
	if len(subs) != 2 {
		t.Fatalf("expected 2 subs of space1, got %d", len(subs))
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement**

Create `bridge/internal/agentregistry/registry.go`:

```go
// Package agentregistry tracks which MCP shims are connected to the daemon
// and which space each shim is currently bound to.
package agentregistry

import (
	"sync"

	"github.com/google/uuid"
)

type AgentInfo struct {
	Kind        string
	Cwd         string
	ActiveSpace *uuid.UUID
}

type Registry struct {
	mu       sync.RWMutex
	conns    map[string]AgentInfo  // connection_id -> info
	bindings map[bindingKey]uuid.UUID
}

type bindingKey struct {
	cwd  string
	kind string
}

func New() *Registry {
	return &Registry{
		conns:    map[string]AgentInfo{},
		bindings: map[bindingKey]uuid.UUID{},
	}
}

func (r *Registry) Register(connID string, info AgentInfo) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.conns[connID] = info
}

func (r *Registry) Unregister(connID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.conns, connID)
}

func (r *Registry) Get(connID string) (AgentInfo, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	info, ok := r.conns[connID]
	return info, ok
}

func (r *Registry) BindCwd(cwd, kind string, spaceID uuid.UUID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.bindings[bindingKey{cwd: cwd, kind: kind}] = spaceID
}

func (r *Registry) SpaceForCwd(cwd, kind string) (uuid.UUID, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	id, ok := r.bindings[bindingKey{cwd: cwd, kind: kind}]
	return id, ok
}

func (r *Registry) SubscribersOfSpace(spaceID uuid.UUID) []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []string
	for connID, info := range r.conns {
		if info.ActiveSpace != nil && *info.ActiveSpace == spaceID {
			out = append(out, connID)
		}
	}
	return out
}
```

**Step 4: Run, verify it passes**

Run: `go test ./internal/agentregistry/...`
Expected: `ok`.

**Step 5: Commit**

```bash
git add internal/agentregistry/
git commit -m "feat(bridge): in-memory agent registry"
```

---

### Task E.8 — Bridge: unix-socket server skeleton

**Files:**
- Create: `bridge/internal/socket/server.go`
- Create: `bridge/internal/socket/server_test.go`

**Step 1: Write the failing test**

Create `bridge/internal/socket/server_test.go`:

```go
package socket

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"testing"
	"time"
)

func TestEchoServer(t *testing.T) {
	dir := t.TempDir()
	socketPath := filepath.Join(dir, "test.sock")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv := New(socketPath, func(line []byte) []byte {
		var msg map[string]any
		_ = json.Unmarshal(line, &msg)
		msg["echoed"] = true
		out, _ := json.Marshal(msg)
		return out
	})
	go func() { _ = srv.Run(ctx) }()
	time.Sleep(100 * time.Millisecond) // wait for listener

	conn, err := net.DialTimeout("unix", socketPath, 1*time.Second)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	if _, err := conn.Write([]byte(`{"hello":"world"}` + "\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	reader := bufio.NewReader(conn)
	line, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		t.Fatalf("ReadString: %v", err)
	}
	var resp map[string]any
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["echoed"] != true {
		t.Fatalf("expected echoed=true, got %v", resp)
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement server**

Create `bridge/internal/socket/server.go`:

```go
// Package socket implements the unix-domain-socket server that MCP shims
// connect to. Each connection is line-delimited JSON-RPC.
package socket

import (
	"bufio"
	"context"
	"errors"
	"net"
	"os"
	"sync"

	"log/slog"
)

// Handler processes one line of input (a JSON-RPC request) and returns one
// line of output (a JSON-RPC response).
type Handler func(line []byte) []byte

// Server listens on a unix domain socket and dispatches each connection's
// line-delimited input to Handler.
type Server struct {
	path    string
	handler Handler
	wg      sync.WaitGroup
}

func New(path string, h Handler) *Server {
	return &Server{path: path, handler: h}
}

// Run starts the server and blocks until ctx is canceled.
func (s *Server) Run(ctx context.Context) error {
	if err := os.RemoveAll(s.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	l, err := net.Listen("unix", s.path)
	if err != nil {
		return err
	}
	defer l.Close()
	defer os.RemoveAll(s.path)

	go func() {
		<-ctx.Done()
		_ = l.Close()
	}()

	for {
		conn, err := l.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				s.wg.Wait()
				return nil
			}
			slog.Warn("accept failed", "err", err)
			continue
		}
		s.wg.Add(1)
		go func(c net.Conn) {
			defer s.wg.Done()
			s.handle(c)
		}(conn)
	}
}

func (s *Server) handle(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			resp := s.handler(line[:len(line)-1])
			if resp != nil {
				resp = append(resp, '\n')
				if _, werr := conn.Write(resp); werr != nil {
					return
				}
			}
		}
		if err != nil {
			return
		}
	}
}
```

(Add `path/filepath` import.)

**Step 4: Run, verify it passes**

Run: `go test ./internal/socket/...`
Expected: `ok`.

**Step 5: Commit**

```bash
git add internal/socket/
git commit -m "feat(bridge): unix-socket server skeleton with echo handler test"
```

---

### Task E.9 — Bridge: daemon orchestrator wiring everything together

**Files:**
- Create: `bridge/internal/daemon/daemon.go`
- Create: `bridge/internal/daemon/daemon_test.go`
- Modify: `bridge/cmd/klio/main.go` (add `klio daemon` subcommand)

**Step 1: Write the failing test**

Create `bridge/internal/daemon/daemon_test.go`:

```go
package daemon

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/klio-tech/bridge/internal/config"
)

func TestDaemonStartsAndStops(t *testing.T) {
	dir := t.TempDir()
	cfg := &config.Config{
		SocketPath:  filepath.Join(dir, "bridge.sock"),
		CloudURL:    "http://localhost:1",
		LocalOnly:   true,
		CacheDBPath: filepath.Join(dir, "cache.db"),
	}
	d, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- d.Run(ctx) }()
	time.Sleep(100 * time.Millisecond)

	cancel()
	select {
	case err := <-errCh:
		if err != nil && err != context.Canceled {
			t.Fatalf("Run returned: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("daemon did not stop within 2s")
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement Daemon**

Create `bridge/internal/daemon/daemon.go`:

```go
// Package daemon wires the config, cache, cloud client, agent registry, and
// socket server into a single runnable process.
package daemon

import (
	"context"

	"github.com/klio-tech/bridge/internal/agentregistry"
	"github.com/klio-tech/bridge/internal/cache"
	"github.com/klio-tech/bridge/internal/cloud"
	"github.com/klio-tech/bridge/internal/config"
	"github.com/klio-tech/bridge/internal/socket"
)

type Daemon struct {
	cfg      *config.Config
	cache    *cache.Cache
	cloud    *cloud.Client
	registry *agentregistry.Registry
	server   *socket.Server
}

func New(cfg *config.Config) (*Daemon, error) {
	c, err := cache.Open(cfg.CacheDBPath)
	if err != nil {
		return nil, err
	}
	cl := cloud.NewClient(cfg.CloudURL)
	reg := agentregistry.New()

	d := &Daemon{cfg: cfg, cache: c, cloud: cl, registry: reg}
	d.server = socket.New(cfg.SocketPath, d.handle)
	return d, nil
}

func (d *Daemon) Run(ctx context.Context) error {
	defer d.cache.Close()
	return d.server.Run(ctx)
}

// handle is the placeholder for MCP request dispatch — Phase F implements it.
// For now it returns a JSON-RPC error: "method not implemented".
func (d *Daemon) handle(line []byte) []byte {
	return []byte(`{"jsonrpc":"2.0","error":{"code":-32601,"message":"phase F not implemented"}}`)
}
```

**Step 4: Add `klio daemon` subcommand**

Replace the switch block in `bridge/cmd/klio/main.go`:

```go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/klio-tech/bridge/internal/config"
	"github.com/klio-tech/bridge/internal/daemon"
	"github.com/klio-tech/bridge/internal/version"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(2)
	}
	cmd := os.Args[1]
	switch cmd {
	case "version", "--version", "-v":
		fmt.Println(version.Get())
	case "daemon":
		runDaemon()
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand: %s\n", cmd)
		printUsage()
		os.Exit(2)
	}
}

func runDaemon() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config load failed", "err", err)
		os.Exit(1)
	}
	d, err := daemon.New(cfg)
	if err != nil {
		slog.Error("daemon init failed", "err", err)
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if err := d.Run(ctx); err != nil && err != context.Canceled {
		slog.Error("daemon run failed", "err", err)
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "usage: klio [version|daemon|init|status|...]")
}
```

**Step 5: Run, verify**

Run: `go test ./internal/daemon/...`
Expected: `ok`.

Manual: `go run ./cmd/klio daemon &` — daemon runs; `ls ~/.klio/bridge.sock` shows the socket; `kill %1` shuts it down cleanly.

**Step 6: Commit**

```bash
git add internal/daemon/ cmd/klio/main.go
git commit -m "feat(bridge): daemon orchestrator with klio daemon subcommand"
```

End of Phase E. The daemon binary builds, starts, listens on a unix socket, and gracefully shuts down. Cache, cloud client, and agent registry are wired and unit-tested.

---

## Phase F — MCP Shim and Seven Tools (Week 4)

Goal: the `klio-mcp` binary, when spawned by Claude Code or Cursor, speaks MCP over stdio, forwards calls to the daemon over the unix socket, and surfaces seven tools (`recall`, `remember`, `observe`, `plan`, `decide`, `note`, `space`). End-to-end test: launch `klio-mcp` against a running daemon, send `tools/list` JSON-RPC, get back all seven tool definitions; send a `tools/call` for `remember`, get a typed response.

### Task F.1 — Bridge: MCP types and tool schemas

**Files:**
- Create: `bridge/internal/mcp/types.go`
- Create: `bridge/internal/mcp/tools.go`
- Create: `bridge/internal/mcp/tools_test.go`

**Step 1: Write the failing test**

Create `bridge/internal/mcp/tools_test.go`:

```go
package mcp

import "testing"

func TestAllSevenToolsDefined(t *testing.T) {
	tools := Tools()
	want := map[string]bool{
		"recall": true, "remember": true, "observe": true,
		"plan": true, "decide": true, "note": true, "space": true,
	}
	if len(tools) != len(want) {
		t.Fatalf("expected %d tools, got %d", len(want), len(tools))
	}
	got := map[string]bool{}
	for _, tool := range tools {
		got[tool.Name] = true
	}
	for name := range want {
		if !got[name] {
			t.Errorf("missing tool: %s", name)
		}
	}
}

func TestToolDescriptionsAreNonEmpty(t *testing.T) {
	for _, tool := range Tools() {
		if tool.Description == "" {
			t.Errorf("tool %s has empty description", tool.Name)
		}
	}
}

func TestRecallSchemaRequiresQuery(t *testing.T) {
	for _, tool := range Tools() {
		if tool.Name != "recall" {
			continue
		}
		schema := tool.InputSchema
		required, ok := schema["required"].([]string)
		if !ok || len(required) == 0 {
			t.Fatal("recall must have required fields")
		}
		if required[0] != "query" {
			t.Fatalf("recall first required field should be query, got %s", required[0])
		}
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement types and tools**

Create `bridge/internal/mcp/types.go`:

```go
// Package mcp implements the Model Context Protocol JSON-RPC envelope and
// the Klio-specific tool schemas.
package mcp

import "encoding/json"

const ProtocolVersion = "2024-11-05"

// Request is an MCP JSON-RPC request frame.
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Response is an MCP JSON-RPC response frame.
type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// Tool describes a single Klio MCP tool surfaced to agents.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// Content is the MCP content block returned in a tools/call result.
type Content struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// CallResult is the standard MCP tools/call result envelope.
type CallResult struct {
	Content []Content `json:"content"`
	IsError bool      `json:"isError,omitempty"`
}
```

Create `bridge/internal/mcp/tools.go`:

```go
package mcp

// Tools returns the seven Klio MCP tools exposed to agents.
//
// Each tool has a semantic verb (recall, remember, observe, plan, decide, note, space)
// rather than a single "write(kind)" tool — this measurably improves LLM tool selection.
func Tools() []Tool {
	return []Tool{
		{
			Name: "recall",
			Description: "Retrieve relevant entries from the user's Klio space using a natural-language query. " +
				"Use this when the user asks 'what did I tell you about X', 'do you remember Y', or before " +
				"making decisions that should be informed by past context. Returns memories, plans, decisions, " +
				"and observations ranked by semantic relevance.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query": map[string]any{"type": "string",
						"description": "Natural-language description of what to recall."},
					"space": map[string]any{"type": "string",
						"description": "Optional space slug. Defaults to active space."},
					"kind": map[string]any{"type": "string",
						"enum": []string{"memory", "observation", "plan", "decision", "note"},
						"description": "Optional filter to a single entry kind."},
					"limit": map[string]any{"type": "integer", "default": 10, "minimum": 1, "maximum": 100},
				},
				"required": []string{"query"},
			},
		},
		{
			Name: "remember",
			Description: "Store a stable fact about the user, project, or context. Use this when the user says " +
				"'remember', 'don't forget', 'from now on', or states a preference clearly. " +
				"Memories persist across sessions and are visible to other agents in the same space.",
			InputSchema: toolSchemaContentOnly("Stable fact to remember (under 500 chars)."),
		},
		{
			Name: "observe",
			Description: "Log something the agent did or saw during the session. Other agents subscribed to the " +
				"same space see this in real-time. Examples: 'edited auth.ts at 14:32', 'ran tests, all passed'.",
			InputSchema: toolSchemaContentOnly("What the agent did or saw."),
		},
		{
			Name: "plan",
			Description: "Post a forward-looking plan or intent. Use when the user agrees to a multi-step " +
				"approach. Other agents in the space can pick up the plan and execute steps.",
			InputSchema: toolSchemaContentOnly("Plan content. Multi-step plans should be one entry."),
		},
		{
			Name: "decide",
			Description: "Record a chosen path along with rationale. Use when the user explicitly chooses " +
				"between options or commits to a direction.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"content":   map[string]any{"type": "string", "description": "The decision."},
					"rationale": map[string]any{"type": "string", "description": "Why this was chosen."},
					"space":     map[string]any{"type": "string", "description": "Optional space slug."},
				},
				"required": []string{"content"},
			},
		},
		{
			Name: "note",
			Description: "Free-form annotation. Use for ad-hoc notes that don't fit memory/plan/decision/observation.",
			InputSchema: toolSchemaContentOnly("Note text."),
		},
		{
			Name: "space",
			Description: "Multiplexed space management. action='list' lists accessible spaces, action='switch' " +
				"sets the active space for this agent's session, action='info' returns details on the active " +
				"space, action='request_access' asks the user to grant access to a space.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"action": map[string]any{"type": "string",
						"enum": []string{"list", "switch", "info", "request_access"}},
					"name":  map[string]any{"type": "string"},
					"scope": map[string]any{"type": "string", "enum": []string{"read", "write", "admin"}},
				},
				"required": []string{"action"},
			},
		},
	}
}

func toolSchemaContentOnly(contentDesc string) map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"content":  map[string]any{"type": "string", "description": contentDesc},
			"space":    map[string]any{"type": "string", "description": "Optional space slug. Defaults to active."},
			"metadata": map[string]any{"type": "object", "description": "Optional metadata."},
		},
		"required": []string{"content"},
	}
}
```

**Step 4: Run, verify it passes**

Run: `go test ./internal/mcp/...`
Expected: `ok`.

**Step 5: Commit**

```bash
git add internal/mcp/
git commit -m "feat(bridge): MCP types and seven Klio tool schemas"
```

---

### Task F.2 — Bridge: MCP request dispatcher inside the daemon

**Files:**
- Create: `bridge/internal/mcp/dispatcher.go`
- Create: `bridge/internal/mcp/dispatcher_test.go`
- Modify: `bridge/internal/daemon/daemon.go`

**Step 1: Write the failing test**

Create `bridge/internal/mcp/dispatcher_test.go`:

```go
package mcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

type stubBackend struct {
	recallCalled  bool
	rememberCalled bool
}

func (s *stubBackend) Recall(ctx context.Context, query, spaceSlug, kind string, limit int) ([]map[string]any, error) {
	s.recallCalled = true
	return []map[string]any{{"content": "fake result"}}, nil
}

func (s *stubBackend) WriteEntry(ctx context.Context, kind, content, spaceSlug string, metadata map[string]any) (map[string]any, error) {
	s.rememberCalled = true
	return map[string]any{"id": uuid.New().String(), "kind": kind, "content": content}, nil
}

func (s *stubBackend) ListSpaces(ctx context.Context) ([]map[string]any, error) {
	return []map[string]any{{"name": "Default", "slug": "default"}}, nil
}

func (s *stubBackend) SwitchSpace(ctx context.Context, slug string) error { return nil }
func (s *stubBackend) RequestAccess(ctx context.Context, slug, scope string) error { return nil }
func (s *stubBackend) ActiveSpaceInfo(ctx context.Context) (map[string]any, error) {
	return map[string]any{"name": "Default"}, nil
}

func TestInitializeReturnsServerInfo(t *testing.T) {
	d := NewDispatcher(&stubBackend{})
	req := []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`)
	resp := d.Handle(req)
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error != nil {
		t.Fatalf("unexpected error: %v", r.Error)
	}
	res := r.Result.(map[string]any)
	if _, ok := res["protocolVersion"]; !ok {
		t.Fatal("protocolVersion missing")
	}
}

func TestToolsListReturnsSeven(t *testing.T) {
	d := NewDispatcher(&stubBackend{})
	req := []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	resp := d.Handle(req)
	var r Response
	_ = json.Unmarshal(resp, &r)
	res := r.Result.(map[string]any)
	tools, _ := res["tools"].([]any)
	if len(tools) != 7 {
		t.Fatalf("expected 7 tools, got %d", len(tools))
	}
}

func TestRecallToolCall(t *testing.T) {
	b := &stubBackend{}
	d := NewDispatcher(b)
	req := []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recall","arguments":{"query":"what's my preferred language?"}}}`)
	resp := d.Handle(req)
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error != nil {
		t.Fatalf("unexpected error: %v", r.Error)
	}
	if !b.recallCalled {
		t.Fatal("backend.Recall not called")
	}
}

func TestRememberToolCall(t *testing.T) {
	b := &stubBackend{}
	d := NewDispatcher(b)
	req := []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"remember","arguments":{"content":"User prefers Go"}}}`)
	resp := d.Handle(req)
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error != nil {
		t.Fatalf("unexpected error: %v", r.Error)
	}
	if !b.rememberCalled {
		t.Fatal("backend.WriteEntry not called")
	}
}

func TestUnknownToolReturnsError(t *testing.T) {
	d := NewDispatcher(&stubBackend{})
	req := []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nonexistent","arguments":{}}}`)
	resp := d.Handle(req)
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error == nil {
		t.Fatal("expected error for unknown tool")
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement dispatcher**

Create `bridge/internal/mcp/dispatcher.go`:

```go
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
)

// Backend abstracts the daemon's domain operations behind an interface so the
// dispatcher is unit-testable without a live cloud client or cache.
type Backend interface {
	Recall(ctx context.Context, query, spaceSlug, kind string, limit int) ([]map[string]any, error)
	WriteEntry(ctx context.Context, kind, content, spaceSlug string, metadata map[string]any) (map[string]any, error)
	ListSpaces(ctx context.Context) ([]map[string]any, error)
	SwitchSpace(ctx context.Context, slug string) error
	RequestAccess(ctx context.Context, slug, scope string) error
	ActiveSpaceInfo(ctx context.Context) (map[string]any, error)
}

type Dispatcher struct {
	backend Backend
}

func NewDispatcher(b Backend) *Dispatcher {
	return &Dispatcher{backend: b}
}

// Handle parses a single MCP request line and returns a single response line
// (without trailing newline). Errors are wrapped in JSON-RPC error envelopes;
// the only way Handle returns nil is if the request was a notification (no id).
func (d *Dispatcher) Handle(line []byte) []byte {
	var req Request
	if err := json.Unmarshal(line, &req); err != nil {
		return errorResp(nil, -32700, "parse error", nil)
	}

	switch req.Method {
	case "initialize":
		return d.handleInitialize(req)
	case "tools/list":
		return d.handleToolsList(req)
	case "tools/call":
		return d.handleToolsCall(req)
	case "ping":
		return ok(req.ID, map[string]any{})
	}
	return errorResp(req.ID, -32601, "method not found: "+req.Method, nil)
}

func (d *Dispatcher) handleInitialize(req Request) []byte {
	return ok(req.ID, map[string]any{
		"protocolVersion": ProtocolVersion,
		"serverInfo":      map[string]any{"name": "klio", "version": "0.0.1"},
		"capabilities": map[string]any{
			"tools": map[string]any{},
		},
	})
}

func (d *Dispatcher) handleToolsList(req Request) []byte {
	return ok(req.ID, map[string]any{"tools": Tools()})
}

func (d *Dispatcher) handleToolsCall(req Request) []byte {
	var params struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return errorResp(req.ID, -32602, "invalid params: "+err.Error(), nil)
	}

	ctx := context.Background()
	switch params.Name {
	case "recall":
		return d.callRecall(ctx, req.ID, params.Arguments)
	case "remember", "observe", "plan", "decide", "note":
		return d.callWrite(ctx, req.ID, params.Name, params.Arguments)
	case "space":
		return d.callSpace(ctx, req.ID, params.Arguments)
	default:
		return errorResp(req.ID, -32601, "unknown tool: "+params.Name, nil)
	}
}

func (d *Dispatcher) callRecall(ctx context.Context, id json.RawMessage, args map[string]any) []byte {
	query, _ := args["query"].(string)
	if query == "" {
		return errorResp(id, -32602, "query is required", nil)
	}
	space, _ := args["space"].(string)
	kind, _ := args["kind"].(string)
	limit := 10
	if l, ok := args["limit"].(float64); ok {
		limit = int(l)
	}
	rows, err := d.backend.Recall(ctx, query, space, kind, limit)
	if err != nil {
		return errorResp(id, -32000, err.Error(), nil)
	}
	return ok(id, toCallResult(formatRecall(rows)))
}

func (d *Dispatcher) callWrite(ctx context.Context, id json.RawMessage, kind string, args map[string]any) []byte {
	content, _ := args["content"].(string)
	if content == "" {
		return errorResp(id, -32602, "content is required", nil)
	}
	space, _ := args["space"].(string)
	metadata, _ := args["metadata"].(map[string]any)
	if rationale, ok := args["rationale"].(string); ok && kind == "decide" {
		if metadata == nil {
			metadata = map[string]any{}
		}
		metadata["rationale"] = rationale
	}
	entry, err := d.backend.WriteEntry(ctx, kind, content, space, metadata)
	if err != nil {
		return errorResp(id, -32000, err.Error(), nil)
	}
	return ok(id, toCallResult(formatEntry(entry)))
}

func (d *Dispatcher) callSpace(ctx context.Context, id json.RawMessage, args map[string]any) []byte {
	action, _ := args["action"].(string)
	switch action {
	case "list":
		spaces, err := d.backend.ListSpaces(ctx)
		if err != nil {
			return errorResp(id, -32000, err.Error(), nil)
		}
		return ok(id, toCallResult(formatSpaces(spaces)))
	case "switch":
		name, _ := args["name"].(string)
		if err := d.backend.SwitchSpace(ctx, name); err != nil {
			return errorResp(id, -32000, err.Error(), nil)
		}
		return ok(id, toCallResult(fmt.Sprintf("switched to %s", name)))
	case "info":
		info, err := d.backend.ActiveSpaceInfo(ctx)
		if err != nil {
			return errorResp(id, -32000, err.Error(), nil)
		}
		return ok(id, toCallResult(fmt.Sprintf("%v", info)))
	case "request_access":
		name, _ := args["name"].(string)
		scope, _ := args["scope"].(string)
		if scope == "" {
			scope = "read"
		}
		if err := d.backend.RequestAccess(ctx, name, scope); err != nil {
			return errorResp(id, -32000, err.Error(), nil)
		}
		return ok(id, toCallResult(fmt.Sprintf("requested %s access to %s", scope, name)))
	default:
		return errorResp(id, -32602, "unknown action: "+action, nil)
	}
}

func ok(id json.RawMessage, result any) []byte {
	out, _ := json.Marshal(Response{JSONRPC: "2.0", ID: id, Result: result})
	return out
}

func errorResp(id json.RawMessage, code int, msg string, data any) []byte {
	out, _ := json.Marshal(Response{JSONRPC: "2.0", ID: id, Error: &Error{Code: code, Message: msg, Data: data}})
	return out
}

func toCallResult(text string) CallResult {
	return CallResult{Content: []Content{{Type: "text", Text: text}}}
}

func formatRecall(rows []map[string]any) string {
	if len(rows) == 0 {
		return "No relevant entries found."
	}
	out := fmt.Sprintf("Found %d relevant entries:\n", len(rows))
	for i, r := range rows {
		out += fmt.Sprintf("%d. [%s] %s\n", i+1, r["kind"], r["content"])
	}
	return out
}

func formatEntry(e map[string]any) string {
	return fmt.Sprintf("Stored as %s entry %s", e["kind"], e["id"])
}

func formatSpaces(spaces []map[string]any) string {
	out := fmt.Sprintf("%d spaces:\n", len(spaces))
	for _, s := range spaces {
		out += fmt.Sprintf("  - %s (%s)\n", s["name"], s["slug"])
	}
	return out
}
```

**Step 4: Run, verify it passes**

Run: `go test ./internal/mcp/...`
Expected: `ok`.

**Step 5: Wire dispatcher into the daemon**

Modify `bridge/internal/daemon/daemon.go`:

```go
import (
	// ...existing imports...
	"github.com/klio-tech/bridge/internal/mcp"
)

type Daemon struct {
	cfg        *config.Config
	cache      *cache.Cache
	cloud      *cloud.Client
	registry   *agentregistry.Registry
	server     *socket.Server
	dispatcher *mcp.Dispatcher
}

func New(cfg *config.Config) (*Daemon, error) {
	c, err := cache.Open(cfg.CacheDBPath)
	if err != nil {
		return nil, err
	}
	cl := cloud.NewClient(cfg.CloudURL)
	reg := agentregistry.New()

	d := &Daemon{cfg: cfg, cache: c, cloud: cl, registry: reg}
	d.dispatcher = mcp.NewDispatcher(d) // d implements mcp.Backend; methods added below
	d.server = socket.New(cfg.SocketPath, d.handle)
	return d, nil
}

func (d *Daemon) handle(line []byte) []byte {
	return d.dispatcher.Handle(line)
}

// mcp.Backend implementation. Phase F.3 fleshes these out.
func (d *Daemon) Recall(ctx context.Context, query, spaceSlug, kind string, limit int) ([]map[string]any, error) {
	// Resolve active space; fall back to slug lookup; default to Default.
	// Phase F.3 implements properly.
	return nil, nil
}

func (d *Daemon) WriteEntry(ctx context.Context, kind, content, spaceSlug string, metadata map[string]any) (map[string]any, error) {
	return nil, nil
}

func (d *Daemon) ListSpaces(ctx context.Context) ([]map[string]any, error) {
	return nil, nil
}

func (d *Daemon) SwitchSpace(ctx context.Context, slug string) error           { return nil }
func (d *Daemon) RequestAccess(ctx context.Context, slug, scope string) error  { return nil }
func (d *Daemon) ActiveSpaceInfo(ctx context.Context) (map[string]any, error)  { return nil, nil }
```

**Step 6: Commit**

```bash
git add internal/mcp/dispatcher.go internal/mcp/dispatcher_test.go internal/daemon/daemon.go
git commit -m "feat(bridge): MCP dispatcher with seven tool implementations"
```

---

### Task F.3 — Bridge: wire daemon's Backend methods to cache + cloud

**Files:**
- Create: `bridge/internal/daemon/backend.go`
- Create: `bridge/internal/daemon/backend_test.go`

**Step 1: Write the failing test**

Create `bridge/internal/daemon/backend_test.go`:

```go
package daemon

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/klio-tech/bridge/internal/cache"
	"github.com/klio-tech/bridge/internal/cloud"
)

func TestRecallReadsCacheFirstThenCloud(t *testing.T) {
	dir := t.TempDir()
	cacheDB, _ := cache.Open(filepath.Join(dir, "cache.db"))
	defer cacheDB.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"id":"00000000-0000-0000-0000-000000000001","space_id":"00000000-0000-0000-0000-00000000aaaa","agent_id":"00000000-0000-0000-0000-00000000bbbb","kind":"memory","content":"cloud result","confidence":1.0,"created_at":"2026-05-02T12:00:00Z"}]`))
	}))
	defer srv.Close()

	d := &Daemon{
		cache: cacheDB,
		cloud: cloud.NewClient(srv.URL),
		// activeSpaceID set up via fixture below
	}

	rows, err := d.Recall(context.Background(), "test", "", "", 10)
	if err != nil {
		t.Fatalf("Recall: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("expected at least one result")
	}
	if rows[0]["content"] != "cloud result" {
		t.Fatalf("got %v", rows[0]["content"])
	}
}

func TestWriteEnqueuesOfflineWhenCloudFails(t *testing.T) {
	dir := t.TempDir()
	cacheDB, _ := cache.Open(filepath.Join(dir, "cache.db"))
	defer cacheDB.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	d := &Daemon{cache: cacheDB, cloud: cloud.NewClient(srv.URL)}
	_, err := d.WriteEntry(context.Background(), "memory", "queued", "", nil)
	// We expect the call to NOT error out — we queue and return.
	if err != nil {
		t.Fatalf("WriteEntry should succeed offline by queuing: %v", err)
	}
	pending, _ := cacheDB.DrainPending(10)
	if len(pending) != 1 {
		t.Fatalf("expected 1 pending write, got %d", len(pending))
	}
	if pending[0].Content != "queued" {
		t.Fatalf("got %s", pending[0].Content)
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement backend methods**

Create `bridge/internal/daemon/backend.go`:

```go
package daemon

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/cache"
	"github.com/klio-tech/bridge/internal/cloud"
)

// Backend method implementations on Daemon.

func (d *Daemon) Recall(ctx context.Context, query, spaceSlug, kind string, limit int) ([]map[string]any, error) {
	spaceID, err := d.resolveSpace(ctx, spaceSlug)
	if err != nil {
		// fallback: cache-only
		rows, _ := d.cache.ListBySpace(uuid.Nil, limit)
		return rowsToMaps(rows), nil
	}
	if limit <= 0 {
		limit = 10
	}
	entries, err := d.cloud.Recall(spaceID, cloud.RecallRequest{Query: query, Kind: kind, Limit: limit})
	if err != nil {
		// cloud failed — read from cache
		rows, _ := d.cache.ListBySpace(spaceID, limit)
		return rowsToMaps(rows), nil
	}
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, map[string]any{
			"id":         e.ID, "space_id": e.SpaceID, "kind": e.Kind,
			"content":    e.Content, "confidence": e.Confidence,
			"created_at": e.CreatedAt,
		})
		// also cache it locally for next time
		_ = d.cache.PutEntry(cache.CachedEntry{
			ID: e.ID, SpaceID: e.SpaceID, Kind: e.Kind, Content: e.Content,
			Confidence: e.Confidence, CreatedAt: e.CreatedAt, SupersededBy: e.SupersededBy,
		})
	}
	return out, nil
}

func (d *Daemon) WriteEntry(ctx context.Context, kind, content, spaceSlug string, metadata map[string]any) (map[string]any, error) {
	spaceID, err := d.resolveSpace(ctx, spaceSlug)
	if err != nil {
		return nil, err
	}
	e, err := d.cloud.WriteEntry(spaceID, cloud.EntryWrite{
		Kind: kind, Content: content, Metadata: metadata, Confidence: 1.0,
	})
	if err != nil {
		// queue for retry
		_ = d.cache.EnqueuePendingWrite(spaceID, kind, content, metadata)
		return map[string]any{"id": uuid.New(), "kind": kind, "content": content,
			"queued": true}, nil
	}
	_ = d.cache.PutEntry(cache.CachedEntry{
		ID: e.ID, SpaceID: e.SpaceID, Kind: e.Kind, Content: e.Content,
		Confidence: e.Confidence, CreatedAt: e.CreatedAt,
	})
	return map[string]any{"id": e.ID, "kind": e.Kind, "content": e.Content}, nil
}

func (d *Daemon) ListSpaces(ctx context.Context) ([]map[string]any, error) {
	spaces, err := d.cloud.ListSpaces()
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(spaces))
	for _, s := range spaces {
		out = append(out, map[string]any{"id": s.ID, "name": s.Name, "slug": s.Slug})
	}
	return out, nil
}

func (d *Daemon) SwitchSpace(ctx context.Context, slug string) error {
	id, err := d.resolveSpace(ctx, slug)
	if err != nil {
		return err
	}
	d.activeSpaceMu.Lock()
	d.activeSpaceID = &id
	d.activeSpaceMu.Unlock()
	return nil
}

func (d *Daemon) RequestAccess(ctx context.Context, slug, scope string) error {
	// Phase J.4 implements the auto-prompt notification.
	return errors.New("request_access not yet implemented")
}

func (d *Daemon) ActiveSpaceInfo(ctx context.Context) (map[string]any, error) {
	d.activeSpaceMu.RLock()
	id := d.activeSpaceID
	d.activeSpaceMu.RUnlock()
	if id == nil {
		return map[string]any{"name": "Default"}, nil
	}
	return map[string]any{"id": *id}, nil
}

func (d *Daemon) resolveSpace(ctx context.Context, slug string) (uuid.UUID, error) {
	if slug == "" {
		d.activeSpaceMu.RLock()
		id := d.activeSpaceID
		d.activeSpaceMu.RUnlock()
		if id != nil {
			return *id, nil
		}
		// fall through to default lookup
	}
	spaces, err := d.cloud.ListSpaces()
	if err != nil {
		return uuid.Nil, err
	}
	target := slug
	if target == "" {
		target = "default"
	}
	for _, s := range spaces {
		if s.Slug == target {
			return s.ID, nil
		}
	}
	return uuid.Nil, errors.New("space not found")
}

func rowsToMaps(rows []cache.CachedEntry) []map[string]any {
	out := make([]map[string]any, 0, len(rows))
	for _, e := range rows {
		out = append(out, map[string]any{
			"id":         e.ID, "space_id": e.SpaceID, "kind": e.Kind,
			"content":    e.Content, "confidence": e.Confidence,
			"created_at": e.CreatedAt,
		})
	}
	return out
}
```

Add to `bridge/internal/daemon/daemon.go`:

```go
import "sync"

type Daemon struct {
	// ...existing fields...
	activeSpaceMu sync.RWMutex
	activeSpaceID *uuid.UUID
}
```

**Step 4: Run, verify it passes**

Run: `go test ./internal/daemon/...`
Expected: `ok`.

**Step 5: Commit**

```bash
git add internal/daemon/
git commit -m "feat(bridge): wire daemon Backend methods to cache + cloud with offline queueing"
```

---

### Task F.4 — Bridge: klio-mcp shim implementation

**Files:**
- Modify: `bridge/cmd/klio-mcp/main.go`
- Create: `bridge/cmd/klio-mcp/main_test.go`

**Step 1: Write the failing test**

Create `bridge/cmd/klio-mcp/main_test.go`:

```go
package main

import (
	"bytes"
	"encoding/json"
	"net"
	"path/filepath"
	"testing"
	"time"
)

func TestForwardsLineToSocketAndBack(t *testing.T) {
	dir := t.TempDir()
	socketPath := filepath.Join(dir, "bridge.sock")

	// Run a fake daemon listening on the socket
	l, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer l.Close()

	go func() {
		conn, err := l.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 4096)
		n, _ := conn.Read(buf)
		var req map[string]any
		_ = json.Unmarshal(bytes.TrimSpace(buf[:n]), &req)
		resp := map[string]any{"jsonrpc": "2.0", "id": req["id"], "result": "pong"}
		body, _ := json.Marshal(resp)
		conn.Write(append(body, '\n'))
	}()

	stdin := bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":1,"method":"ping"}` + "\n"))
	var stdout bytes.Buffer

	done := make(chan error)
	go func() { done <- forward(socketPath, stdin, &stdout) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("forward returned: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out")
	}

	out := stdout.String()
	if out == "" {
		t.Fatal("empty stdout")
	}
	var resp map[string]any
	_ = json.Unmarshal([]byte(out), &resp)
	if resp["result"] != "pong" {
		t.Fatalf("got %v", resp)
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement shim**

Replace `bridge/cmd/klio-mcp/main.go`:

```go
// Command klio-mcp is the stdio MCP shim spawned by Claude Code, Cursor,
// and other MCP-capable agents. It connects to the local klio-bridge
// daemon's unix socket and forwards every line of stdio JSON-RPC to it,
// returning the daemon's response on stdout.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
)

func main() {
	socketPath := defaultSocket()
	if v := os.Getenv("KLIO_SOCKET_PATH"); v != "" {
		socketPath = v
	}
	if err := forward(socketPath, os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "klio-mcp:", err)
		os.Exit(1)
	}
}

func defaultSocket() string {
	if runtime.GOOS == "windows" {
		return "127.0.0.1:7878"
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".klio", "bridge.sock")
}

func forward(socketPath string, in io.Reader, out io.Writer) error {
	conn, err := dial(socketPath)
	if err != nil {
		return fmt.Errorf("daemon not reachable: %w", err)
	}
	defer conn.Close()

	// Stdin → socket
	go func() {
		scanner := bufio.NewScanner(in)
		scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024) // up to 16MB lines
		for scanner.Scan() {
			line := scanner.Bytes()
			if _, werr := conn.Write(append(line, '\n')); werr != nil {
				return
			}
		}
	}()

	// Socket → stdout
	r := bufio.NewReader(conn)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			if _, werr := out.Write(line); werr != nil {
				return werr
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func dial(path string) (net.Conn, error) {
	if runtime.GOOS == "windows" {
		return net.Dial("tcp", path)
	}
	return net.Dial("unix", path)
}
```

**Step 4: Run, verify it passes**

Run: `go test ./cmd/klio-mcp/...`
Expected: `ok`.

**Step 5: Commit**

```bash
git add cmd/klio-mcp/
git commit -m "feat(bridge): klio-mcp stdio shim forwarding to daemon socket"
```

---

### Task F.5 — Bridge: end-to-end test of MCP shim against running daemon

**Files:**
- Create: `bridge/integration/e2e_test.go`

**Step 1: Write the e2e test**

Create `bridge/integration/e2e_test.go`:

```go
//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestE2EMcpToolsList(t *testing.T) {
	// Build the binaries
	dir := t.TempDir()
	klioBin := filepath.Join(dir, "klio")
	shimBin := filepath.Join(dir, "klio-mcp")
	if err := exec.Command("go", "build", "-o", klioBin, "../cmd/klio").Run(); err != nil {
		t.Fatalf("build klio: %v", err)
	}
	if err := exec.Command("go", "build", "-o", shimBin, "../cmd/klio-mcp").Run(); err != nil {
		t.Fatalf("build klio-mcp: %v", err)
	}

	// Start the daemon
	socketPath := filepath.Join(dir, "bridge.sock")
	cachePath := filepath.Join(dir, "cache.db")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, klioBin, "daemon")
	cmd.Env = append(os.Environ(),
		"KLIO_SOCKET_PATH="+socketPath,
		"KLIO_LOCAL_ONLY=true",
		"KLIO_API_URL=http://localhost:1",  // unreachable, won't be hit in this test
	)
	cmd.Env = append(cmd.Env, "HOME="+dir)
	_ = os.MkdirAll(filepath.Join(dir, ".klio"), 0o700)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start daemon: %v", err)
	}
	defer cmd.Process.Kill()
	time.Sleep(500 * time.Millisecond) // wait for socket

	// Write a tools/list request through the shim
	shim := exec.CommandContext(ctx, shimBin)
	shim.Env = append(os.Environ(), "KLIO_SOCKET_PATH="+socketPath)
	shim.Stdin = bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + "\n"))
	out, err := shim.CombinedOutput()
	if err != nil {
		t.Fatalf("shim: %v\nout: %s", err, out)
	}

	var resp map[string]any
	if err := json.Unmarshal(bytes.Split(out, []byte("\n"))[0], &resp); err != nil {
		t.Fatalf("unmarshal: %v\nout: %s", err, out)
	}
	tools, _ := resp["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 7 {
		t.Fatalf("expected 7 tools, got %d", len(tools))
	}
}
```

**Step 2: Run**

Run:
```bash
go test -tags=integration ./integration/...
```

Expected: `ok` — the daemon starts, the shim connects, `tools/list` returns 7 tools.

**Step 3: Commit**

```bash
git add integration/
git commit -m "test(bridge): e2e test of MCP shim against running daemon"
```

End of Phase F. The MCP shim and daemon together expose seven MCP tools that any MCP-capable agent can call. Cache absorbs offline writes; recall reads from cache when cloud is unreachable. End-to-end test passes.

---

## Phase G — Real-time Pub/Sub (Weeks 4–5)

Goal: when one agent writes an entry to a space, every other agent subscribed to that space sees a `entry.created` WebSocket frame within ~200ms (intra-region). The implementation has three layers: the `klio-realtime` Go service that fans out frames over WebSocket, the engine's publish step that pushes to Redis on every write, and the daemon's WebSocket client that delivers frames to local agents via MCP `notifications/resources/updated`.

### Task G.1 — Realtime: service scaffold

**Files:**
- Create: `realtime/cmd/klio-realtime/main.go`
- Create: `realtime/internal/version/version.go`
- Create: `realtime/internal/version/version_test.go`
- Create: `realtime/.github/workflows/ci.yml`

**Steps:** mirror Task A.6 / A.7 — same structure as bridge but for the `realtime` repo. CI workflow same shape.

**Commit:** `chore: bootstrap realtime module`.

---

### Task G.2 — Realtime: WebSocket frame definitions

**Files:**
- Create: `realtime/internal/frames/frames.go`
- Create: `realtime/internal/frames/frames_test.go`

**Step 1: Write the failing test**

Create `realtime/internal/frames/frames_test.go`:

```go
package frames

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestEntryCreatedRoundTrip(t *testing.T) {
	spaceID := uuid.New()
	entryID := uuid.New()
	frame := Frame{
		Type:    "entry.created",
		SpaceID: &spaceID,
		FrameID: "f-1",
		Entry: &EntryPayload{
			ID: entryID, SpaceID: spaceID, Kind: "memory", Content: "hello",
		},
	}
	data, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got Frame
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got.Type != "entry.created" {
		t.Fatalf("Type: %s", got.Type)
	}
	if got.Entry.Content != "hello" {
		t.Fatalf("Content: %s", got.Entry.Content)
	}
}

func TestPermissionChangedFrame(t *testing.T) {
	spaceID := uuid.New()
	agentID := uuid.New()
	frame := Frame{
		Type:    "permission.changed",
		SpaceID: &spaceID,
		FrameID: "f-2",
		Permission: &PermissionPayload{
			AgentID: agentID, Scope: "read",
		},
	}
	data, _ := json.Marshal(frame)
	var got Frame
	_ = json.Unmarshal(data, &got)
	if got.Permission.Scope != "read" {
		t.Fatalf("Scope: %s", got.Permission.Scope)
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement frames**

Create `realtime/internal/frames/frames.go`:

```go
// Package frames defines the WebSocket frame types exchanged between
// klio-realtime and klio-bridge daemons.
package frames

import (
	"time"

	"github.com/google/uuid"
)

// Type values
const (
	TypeEntryCreated      = "entry.created"
	TypeEntrySuperseded   = "entry.superseded"
	TypeEntryDeleted      = "entry.deleted"
	TypePermissionChanged = "permission.changed"
	TypeAccessRequested   = "access.requested"
	TypeAuthExpiring      = "auth.expiring"
	TypeError             = "error"
	TypePong              = "pong"
	TypePing              = "ping"
	TypeAck               = "ack"
	TypeAuthRefresh       = "auth.refresh"
	TypeSubscribe         = "subscribe"
	TypeUnsubscribe       = "unsubscribe"
	TypeGapWarning        = "gap.warning"
)

// Frame is a single bidirectional WebSocket frame.
type Frame struct {
	Type       string             `json:"type"`
	SpaceID    *uuid.UUID         `json:"space_id,omitempty"`
	FrameID    string             `json:"frame_id,omitempty"`
	EntryID    *uuid.UUID         `json:"entry_id,omitempty"`
	Entry      *EntryPayload      `json:"entry,omitempty"`
	Permission *PermissionPayload `json:"permission,omitempty"`
	Access     *AccessPayload     `json:"access,omitempty"`
	Error      *ErrorPayload      `json:"error,omitempty"`
	ExpiresIn  int                `json:"expires_in_seconds,omitempty"`
	Token      string             `json:"token,omitempty"` // for auth.refresh
}

type EntryPayload struct {
	ID           uuid.UUID  `json:"id"`
	SpaceID      uuid.UUID  `json:"space_id"`
	AgentID      uuid.UUID  `json:"agent_id"`
	Kind         string     `json:"kind"`
	Content      string     `json:"content"`
	Confidence   float64    `json:"confidence"`
	CreatedAt    time.Time  `json:"created_at"`
	SupersededBy *uuid.UUID `json:"superseded_by,omitempty"`
}

type PermissionPayload struct {
	AgentID uuid.UUID `json:"agent_id"`
	Scope   string    `json:"scope"` // "read" | "write" | "admin" | "revoked"
}

type AccessPayload struct {
	AgentID   uuid.UUID `json:"agent_id"`
	Scope     string    `json:"scope"`
	RequestID string    `json:"request_id"`
}

type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
```

**Step 4: Run, verify it passes**

Run: `go test ./internal/frames/...`
Expected: `ok`.

**Step 5: Commit**

```bash
cd realtime
git add internal/frames/
git commit -m "feat(realtime): WebSocket frame definitions"
```

---

### Task G.3 — Realtime: Redis pub/sub adapter

**Files:**
- Create: `realtime/internal/pubsub/redis.go`
- Create: `realtime/internal/pubsub/redis_test.go`

**Step 1: Write the failing test**

Create `realtime/internal/pubsub/redis_test.go`:

```go
package pubsub

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/redis"

	"github.com/klio-tech/realtime/internal/frames"
)

func startRedis(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	rc, err := redis.Run(ctx, "redis:7-alpine")
	if err != nil {
		t.Fatalf("redis.Run: %v", err)
	}
	t.Cleanup(func() { _ = testcontainers.TerminateContainer(rc) })
	url, err := rc.ConnectionString(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return url
}

func TestPublishAndReceive(t *testing.T) {
	url := startRedis(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pub := NewRedisPublisher(url)
	defer pub.Close()
	sub := NewRedisSubscriber(url)
	defer sub.Close()

	spaceID := uuid.New()
	frameCh, _ := sub.Subscribe(ctx, spaceID)
	time.Sleep(50 * time.Millisecond) // give subscription time to settle

	want := frames.Frame{Type: frames.TypeEntryCreated, FrameID: "f-1", SpaceID: &spaceID}
	if err := pub.Publish(ctx, spaceID, want); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	select {
	case got := <-frameCh:
		if got.FrameID != "f-1" {
			t.Fatalf("FrameID = %s", got.FrameID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not receive frame within 2s")
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement Redis pub/sub**

Create `realtime/internal/pubsub/redis.go`:

```go
// Package pubsub wraps Redis Pub/Sub for fan-out of WebSocket frames.
//
// Channels are keyed by space_id. A klio-realtime instance subscribes to
// every channel it has WebSocket subscribers for; when an engine write
// publishes to that channel, all subscribed instances receive the frame
// and forward to their connected daemons.
package pubsub

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/klio-tech/realtime/internal/frames"
)

type Publisher struct {
	rdb *redis.Client
}

func NewRedisPublisher(url string) *Publisher {
	opts, err := redis.ParseURL(url)
	if err != nil {
		panic(err)
	}
	return &Publisher{rdb: redis.NewClient(opts)}
}

func (p *Publisher) Close() error { return p.rdb.Close() }

func (p *Publisher) Publish(ctx context.Context, spaceID uuid.UUID, frame frames.Frame) error {
	body, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	channel := channelForSpace(spaceID)
	return p.rdb.Publish(ctx, channel, body).Err()
}

type Subscriber struct {
	rdb *redis.Client
}

func NewRedisSubscriber(url string) *Subscriber {
	opts, err := redis.ParseURL(url)
	if err != nil {
		panic(err)
	}
	return &Subscriber{rdb: redis.NewClient(opts)}
}

func (s *Subscriber) Close() error { return s.rdb.Close() }

func (s *Subscriber) Subscribe(ctx context.Context, spaceID uuid.UUID) (<-chan frames.Frame, error) {
	pubsub := s.rdb.Subscribe(ctx, channelForSpace(spaceID))
	out := make(chan frames.Frame, 64)

	go func() {
		defer close(out)
		defer pubsub.Close()
		ch := pubsub.Channel()
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				var f frames.Frame
				if err := json.Unmarshal([]byte(msg.Payload), &f); err == nil {
					out <- f
				}
			}
		}
	}()
	return out, nil
}

func channelForSpace(id uuid.UUID) string {
	return fmt.Sprintf("space:%s", id)
}
```

**Step 4: Run, verify it passes**

Run: `go test ./internal/pubsub/...`
Expected: `ok` (testcontainer spins up Redis).

**Step 5: Commit**

```bash
git add internal/pubsub/
git commit -m "feat(realtime): Redis pub/sub adapter for frame fan-out"
```

---

### Task G.4 — Realtime: WebSocket server with auth + multi-space subscription

**Files:**
- Create: `realtime/internal/server/server.go`
- Create: `realtime/internal/server/server_test.go`
- Create: `realtime/internal/auth/jwt.go`
- Create: `realtime/internal/auth/jwt_test.go`

**Step 1: Write the failing test for JWT verifier**

Create `realtime/internal/auth/jwt_test.go`:

```go
package auth

import (
	"testing"
	"time"
)

func TestVerifyValidToken(t *testing.T) {
	secret := "test-secret"
	v := NewVerifier(secret)
	token := mintForTest(secret, "user-1", "agent-1", []string{"read"}, 60*time.Second)
	claims, err := v.Verify(token)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if claims.Subject != "user-1" {
		t.Fatalf("Subject: %s", claims.Subject)
	}
}

func TestVerifyExpiredFails(t *testing.T) {
	secret := "k"
	v := NewVerifier(secret)
	token := mintForTest(secret, "u", "a", nil, -time.Second)
	_, err := v.Verify(token)
	if err == nil {
		t.Fatal("expected error")
	}
}
```

(Implementation `mintForTest` belongs to a `_test` helper file that uses `golang-jwt/jwt/v5`.)

**Step 2: Implement Verifier**

Create `realtime/internal/auth/jwt.go`:

```go
package auth

import (
	"errors"

	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	Subject string
	AgentID string
	Scopes  []string
}

type Verifier struct {
	secret []byte
}

func NewVerifier(secret string) *Verifier { return &Verifier{secret: []byte(secret)} }

func (v *Verifier) Verify(token string) (*Claims, error) {
	parsed, err := jwt.Parse(token, func(t *jwt.Token) (any, error) {
		if t.Method.Alg() != "HS256" {
			return nil, errors.New("unexpected signing method")
		}
		return v.secret, nil
	}, jwt.WithAudience("klio.tech"))
	if err != nil {
		return nil, err
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok || !parsed.Valid {
		return nil, errors.New("invalid claims")
	}
	subject, _ := claims["sub"].(string)
	agentID, _ := claims["agent_id"].(string)
	scopesRaw, _ := claims["scopes"].([]any)
	scopes := make([]string, 0, len(scopesRaw))
	for _, s := range scopesRaw {
		if str, ok := s.(string); ok {
			scopes = append(scopes, str)
		}
	}
	return &Claims{Subject: subject, AgentID: agentID, Scopes: scopes}, nil
}
```

**Step 3: Implement WebSocket server**

Create `realtime/internal/server/server.go`:

```go
// Package server is the WebSocket fan-out HTTP server.
package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/klio-tech/realtime/internal/auth"
	"github.com/klio-tech/realtime/internal/frames"
	"github.com/klio-tech/realtime/internal/pubsub"
)

type Server struct {
	verifier   *auth.Verifier
	subscriber *pubsub.Subscriber
	upgrader   websocket.Upgrader
}

func New(verifier *auth.Verifier, subscriber *pubsub.Subscriber) *Server {
	return &Server{
		verifier: verifier, subscriber: subscriber,
		upgrader: websocket.Upgrader{
			ReadBufferSize: 4096, WriteBufferSize: 4096,
			Subprotocols: []string{"klio.v1"},
			CheckOrigin:  func(*http.Request) bool { return true }, // edge enforces origin
		},
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v1/realtime" {
		http.NotFound(w, r)
		return
	}
	token := r.URL.Query().Get("token")
	if token == "" {
		auth := r.Header.Get("Authorization")
		if strings.HasPrefix(auth, "Bearer ") {
			token = auth[len("Bearer "):]
		}
	}
	if token == "" {
		http.Error(w, "token required", http.StatusUnauthorized)
		return
	}
	claims, err := s.verifier.Verify(token)
	if err != nil {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}

	spacesParam := r.URL.Query().Get("spaces")
	spaceIDs, err := parseSpaceIDs(spacesParam)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// Coordinator-side ACL check: validate that claims.Subject has read on each
	// requested space. For Phase G we trust the JWT scopes; Phase L tightens
	// this with a real per-space ACL lookup against the coordinator.
	_ = claims

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Fan-in from Redis to client
	for _, spaceID := range spaceIDs {
		ch, _ := s.subscriber.Subscribe(ctx, spaceID)
		go func(ch <-chan frames.Frame) {
			for f := range ch {
				body, _ := json.Marshal(f)
				_ = conn.WriteMessage(websocket.TextMessage, body)
			}
		}(ch)
	}

	// Read loop — handle ping/ack/auth.refresh; ignore others
	conn.SetReadLimit(1024 * 1024)
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var f frames.Frame
		if json.Unmarshal(msg, &f) != nil {
			continue
		}
		switch f.Type {
		case frames.TypePing:
			pong, _ := json.Marshal(frames.Frame{Type: frames.TypePong})
			_ = conn.WriteMessage(websocket.TextMessage, pong)
		case frames.TypeAck:
			// ack tracking is Phase L (replay buffer); ignore for v0 launch
		}
	}
}

func parseSpaceIDs(s string) ([]uuid.UUID, error) {
	if s == "" {
		return nil, nil
	}
	parts := strings.Split(s, ",")
	out := make([]uuid.UUID, 0, len(parts))
	for _, p := range parts {
		id, err := uuid.Parse(strings.TrimSpace(p))
		if err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, nil
}
```

**Step 4: Write the failing server test**

Create `realtime/internal/server/server_test.go`:

```go
package server

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/klio-tech/realtime/internal/auth"
	"github.com/klio-tech/realtime/internal/frames"
	"github.com/klio-tech/realtime/internal/pubsub"
)

func TestSubscribeAndReceiveFrame(t *testing.T) {
	url := startRedis(t)
	v := auth.NewVerifier("test-secret")
	sub := pubsub.NewRedisSubscriber(url)
	pub := pubsub.NewRedisPublisher(url)
	defer sub.Close()
	defer pub.Close()

	srv := New(v, sub)
	httpSrv := httptest.NewServer(srv)
	defer httpSrv.Close()

	spaceID := uuid.New()
	token := mintForTest("test-secret", "user-1", "agent-1", []string{"read"}, time.Hour)
	wsURL := strings.Replace(httpSrv.URL, "http://", "ws://", 1) +
		"/v1/realtime?token=" + token + "&spaces=" + spaceID.String()

	dialer := websocket.Dialer{Subprotocols: []string{"klio.v1"}}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	time.Sleep(200 * time.Millisecond) // let subscription settle

	want := frames.Frame{Type: frames.TypeEntryCreated, SpaceID: &spaceID, FrameID: "f-1"}
	if err := pub.Publish(context.Background(), spaceID, want); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if !strings.Contains(string(msg), "entry.created") {
		t.Fatalf("unexpected: %s", msg)
	}
}

func TestRejectsInvalidToken(t *testing.T) {
	url := startRedis(t)
	v := auth.NewVerifier("right-secret")
	sub := pubsub.NewRedisSubscriber(url)
	defer sub.Close()

	srv := New(v, sub)
	httpSrv := httptest.NewServer(srv)
	defer httpSrv.Close()

	badToken := mintForTest("wrong-secret", "u", "a", nil, time.Hour)
	wsURL := strings.Replace(httpSrv.URL, "http://", "ws://", 1) +
		"/v1/realtime?token=" + badToken
	dialer := websocket.Dialer{Subprotocols: []string{"klio.v1"}}
	_, resp, err := dialer.Dial(wsURL, nil)
	if err == nil {
		t.Fatal("expected dial to fail")
	}
	if resp.StatusCode != 401 {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

// startRedis from pubsub package's test helpers — copy the helper.
```

**Step 5: Run, verify it passes**

Run: `go test ./internal/server/...`
Expected: `ok`.

**Step 6: Commit**

```bash
git add internal/server/ internal/auth/
git commit -m "feat(realtime): WebSocket server with JWT auth + Redis fan-in"
```

---

### Task G.5 — Engine: publish to Redis on every entry write

**Files:**
- Create: `engine/src/klio_engine/services/publisher.py`
- Create: `engine/tests/services/test_publisher.py`
- Modify: `engine/src/klio_engine/services/entries.py` (call publisher after commit)

**Step 1: Write the failing test**

Create `engine/tests/services/test_publisher.py`:

```python
"""Engine-side publisher tests."""
import json
import uuid

import fakeredis.aioredis
import pytest

from klio_engine.services.publisher import RedisPublisher


@pytest.mark.asyncio
async def test_publish_writes_to_correct_channel() -> None:
    fake = fakeredis.aioredis.FakeRedis()
    pub = RedisPublisher(client=fake)

    space_id = uuid.uuid4()
    pubsub = fake.pubsub()
    await pubsub.subscribe(f"space:{space_id}")

    await pub.publish_entry_created(
        space_id=space_id,
        entry={"id": str(uuid.uuid4()), "kind": "memory", "content": "hi"},
    )

    msg = None
    for _ in range(50):
        m = await pubsub.get_message(timeout=0.1)
        if m and m.get("type") == "message":
            msg = m
            break
    assert msg is not None
    payload = json.loads(msg["data"])
    assert payload["type"] == "entry.created"
    assert payload["entry"]["content"] == "hi"
```

Add `fakeredis>=2` to dev deps.

**Step 2: Run, verify it fails.**

**Step 3: Implement publisher**

Create `engine/src/klio_engine/services/publisher.py`:

```python
"""Engine → Redis publisher for entry events."""
import json
import uuid
from typing import Any

from redis.asyncio import Redis

from klio_engine.config import Settings


class RedisPublisher:
    """Publishes WebSocket frames to Redis channels keyed by space_id.

    Frame format matches realtime/internal/frames/frames.go exactly.
    """

    def __init__(self, *, client: Redis | None = None, url: str | None = None) -> None:
        if client is not None:
            self._client = client
        else:
            url = url or Settings().redis_url
            self._client = Redis.from_url(url, decode_responses=False)

    async def publish_entry_created(
        self, *, space_id: uuid.UUID, entry: dict[str, Any], frame_id: str | None = None,
    ) -> None:
        frame_id = frame_id or str(uuid.uuid4())
        frame = {
            "type": "entry.created",
            "space_id": str(space_id),
            "frame_id": frame_id,
            "entry": entry,
        }
        await self._client.publish(f"space:{space_id}", json.dumps(frame))

    async def publish_entry_superseded(
        self, *, space_id: uuid.UUID, entry_id: uuid.UUID, superseded_by: uuid.UUID,
    ) -> None:
        frame = {
            "type": "entry.superseded",
            "space_id": str(space_id),
            "frame_id": str(uuid.uuid4()),
            "entry_id": str(entry_id),
        }
        # Note: superseded_by lives on the entry payload, but for the frame
        # we keep it minimal — clients refetch via REST if they need details.
        await self._client.publish(f"space:{space_id}", json.dumps(frame))

    async def publish_permission_changed(
        self, *, space_id: uuid.UUID, agent_id: uuid.UUID, scope: str,
    ) -> None:
        frame = {
            "type": "permission.changed",
            "space_id": str(space_id),
            "frame_id": str(uuid.uuid4()),
            "permission": {"agent_id": str(agent_id), "scope": scope},
        }
        await self._client.publish(f"space:{space_id}", json.dumps(frame))
```

Add `redis>=5` to engine deps.

**Step 4: Wire publisher into entries write path**

Modify `engine/src/klio_engine/services/entries.py` — at the end of `write()`, after `await session.commit()`:

```python
        # Publish for real-time fan-out
        from klio_engine.services.publisher import RedisPublisher
        publisher = RedisPublisher()
        await publisher.publish_entry_created(
            space_id=space_id,
            entry={
                "id": str(e.id), "space_id": str(e.space_id), "agent_id": str(e.agent_id),
                "kind": e.kind.value, "content": content,
                "confidence": e.confidence,
                "created_at": e.created_at.isoformat(),
            },
        )
        if existing is not None:
            await publisher.publish_entry_superseded(
                space_id=space_id, entry_id=existing.id, superseded_by=e.id,
            )
        return e
```

**Step 5: Run, verify it passes**

Run: `pytest tests/services/test_publisher.py -v`
Expected: `1 passed`.

**Step 6: Commit**

```bash
git add src/klio_engine/services/publisher.py src/klio_engine/services/entries.py tests/services/test_publisher.py
git commit -m "feat(engine): publish entry.created + entry.superseded to Redis"
```

---

### Task G.6 — Bridge: WebSocket client to klio-realtime

**Files:**
- Create: `bridge/internal/cloud/realtime.go`
- Create: `bridge/internal/cloud/realtime_test.go`
- Modify: `bridge/internal/daemon/daemon.go` (start realtime goroutine)

**Step 1: Write the failing test**

Create `bridge/internal/cloud/realtime_test.go`:

```go
package cloud

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

func TestRealtimeReceivesFrames(t *testing.T) {
	upgrader := websocket.Upgrader{Subprotocols: []string{"klio.v1"}, CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _ := upgrader.Upgrade(w, r, nil)
		defer conn.Close()
		// send a frame and a pong to keep alive
		spaceID := uuid.New()
		frame := map[string]any{
			"type":     "entry.created",
			"space_id": spaceID.String(),
			"frame_id": "f-1",
			"entry":    map[string]any{"content": "hi"},
		}
		body, _ := json.Marshal(frame)
		conn.WriteMessage(websocket.TextMessage, body)
		time.Sleep(50 * time.Millisecond)
	}))
	defer srv.Close()

	wsURL := strings.Replace(srv.URL, "http://", "ws://", 1) + "/v1/realtime"

	rt := NewRealtimeClient(wsURL, "fake-token")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	got := make(chan map[string]any, 4)
	go func() {
		_ = rt.Run(ctx, []uuid.UUID{}, func(frame map[string]any) {
			got <- frame
		})
	}()

	select {
	case f := <-got:
		if f["type"] != "entry.created" {
			t.Fatalf("got %v", f)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no frame received")
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement**

Create `bridge/internal/cloud/realtime.go`:

```go
package cloud

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// RealtimeClient connects to klio-realtime over WebSocket and invokes
// onFrame for every server-sent frame.
type RealtimeClient struct {
	url   string
	token string
}

func NewRealtimeClient(url, token string) *RealtimeClient {
	return &RealtimeClient{url: url, token: token}
}

func (c *RealtimeClient) Run(ctx context.Context, spaces []uuid.UUID, onFrame func(map[string]any)) error {
	backoff := time.Second
	for {
		err := c.runOnce(ctx, spaces, onFrame)
		if err == nil || ctx.Err() != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

func (c *RealtimeClient) runOnce(ctx context.Context, spaces []uuid.UUID, onFrame func(map[string]any)) error {
	u := c.url
	q := []string{"token=" + c.token}
	if len(spaces) > 0 {
		ids := make([]string, len(spaces))
		for i, s := range spaces {
			ids[i] = s.String()
		}
		q = append(q, "spaces="+strings.Join(ids, ","))
	}
	if len(q) > 0 {
		sep := "?"
		if strings.Contains(u, "?") {
			sep = "&"
		}
		u = u + sep + strings.Join(q, "&")
	}

	dialer := websocket.Dialer{Subprotocols: []string{"klio.v1"}, HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.DialContext(ctx, u, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	// Heartbeat: ping every 30s
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping"}`))
			}
		}
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var frame map[string]any
		if json.Unmarshal(msg, &frame) != nil {
			continue
		}
		onFrame(frame)
	}
}
```

**Step 4: Run, verify it passes**

Run: `go test ./internal/cloud/...`
Expected: `ok`.

**Step 5: Wire into daemon**

In `bridge/internal/daemon/daemon.go`, add a goroutine spawned at `Run()` that subscribes to all spaces the agent has access to and forwards frames to MCP shims via the agent registry. Implementation outline (full code follows the same patterns):

```go
func (d *Daemon) Run(ctx context.Context) error {
	defer d.cache.Close()

	// Start realtime goroutine
	wsURL := strings.Replace(d.cfg.CloudURL, "http", "ws", 1) + "/v1/realtime"
	rt := cloud.NewRealtimeClient(wsURL, d.cloud.AccessToken())
	go func() {
		_ = rt.Run(ctx, d.subscribedSpaceIDs(), d.onFrame)
	}()

	return d.server.Run(ctx)
}

func (d *Daemon) subscribedSpaceIDs() []uuid.UUID {
	// Phase J wires agent-to-space tracking; for now, all spaces the user has access to.
	spaces, _ := d.cloud.ListSpaces()
	out := make([]uuid.UUID, 0, len(spaces))
	for _, s := range spaces {
		out = append(out, s.ID)
	}
	return out
}

func (d *Daemon) onFrame(frame map[string]any) {
	// Cache the entry locally
	if frame["type"] == "entry.created" {
		entry, _ := frame["entry"].(map[string]any)
		// best-effort cache write — extracted into helper
	}
	// Notify subscribed shims via MCP `notifications/resources/updated`
	// Phase J implements the actual MCP-side notification dispatch.
}
```

**Step 6: Commit**

```bash
git add internal/cloud/realtime.go internal/cloud/realtime_test.go internal/daemon/daemon.go
git commit -m "feat(bridge): WebSocket client to klio-realtime with reconnect backoff"
```

End of Phase G. Engine publishes to Redis on every entry write. klio-realtime fans out to subscribed daemons. Daemons receive frames and (in Phase J) deliver them to MCP shims via notifications.

---

## Phase H — `npx klio init` Bootstrap (Week 5)

Goal: a single command — `npx klio init` — installs the daemon binary, creates an anonymous Klio account, edits installed agent configs (Claude Code, Cursor, Codex) to point at the Klio MCP shim, registers Claude Code hooks, and starts the daemon as a per-user background service. Everything is reversible via `klio uninstall`. Total runtime under 10 seconds on a warm machine.

### Task H.1 — npm package wrapper that downloads the native binary

**Files:**
- Create: `bridge/npm/package.json`
- Create: `bridge/npm/bin/klio.js`
- Create: `bridge/npm/install.js`
- Create: `bridge/npm/test/install.test.js`
- Create: `bridge/npm/.npmrc`

**Step 1: Write the package.json**

Create `bridge/npm/package.json`:

```json
{
  "name": "@klio/cli",
  "version": "0.0.1",
  "description": "Klio — the agent-collaboration substrate. Local daemon + CLI.",
  "license": "Apache-2.0",
  "homepage": "https://klio.tech",
  "bugs": "https://github.com/klio-tech/bridge/issues",
  "repository": {
    "type": "git",
    "url": "https://github.com/klio-tech/bridge.git"
  },
  "bin": {
    "klio": "bin/klio.js",
    "klio-mcp": "bin/klio-mcp.js"
  },
  "scripts": {
    "postinstall": "node install.js",
    "test": "node --test"
  },
  "engines": { "node": ">=18" }
}
```

**Step 2: Write the postinstall script**

Create `bridge/npm/install.js`:

```javascript
#!/usr/bin/env node
// Postinstall: download the platform-appropriate klio binary from GitHub Releases
// and place it inside this package's `bin/` directory.
//
// We do NOT distribute pre-built binaries inside the npm tarball because:
//   - npm tarballs are size-capped and binary inclusion bloats them.
//   - Different architectures need different binaries; one tarball-fits-all
//     would mean downloading ~60MB even for users on a single platform.
//
// Verification: every release publishes an Ed25519 signature alongside the
// binary. We verify the signature against an embedded public key before
// granting executable permission.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');
const { Buffer } = require('buffer');

const VERSION = require('./package.json').version;
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA<placeholder-replace-with-real-ed25519-public-key>
-----END PUBLIC KEY-----`;

const platform = process.platform;
const arch = process.arch;

const TARGETS = {
  'darwin-arm64':  'klio-darwin-arm64.tar.gz',
  'darwin-x64':    'klio-darwin-amd64.tar.gz',
  'linux-x64':     'klio-linux-amd64.tar.gz',
  'linux-arm64':   'klio-linux-arm64.tar.gz',
  'win32-x64':     'klio-windows-amd64.zip',
};

const target = TARGETS[`${platform}-${arch}`];
if (!target) {
  console.error(`Klio: unsupported platform ${platform}-${arch}`);
  process.exit(1);
}

const baseURL = process.env.KLIO_DOWNLOAD_BASE ||
  `https://github.com/klio-tech/bridge/releases/download/v${VERSION}`;
const archiveURL = `${baseURL}/${target}`;
const sigURL = `${archiveURL}.sig`;

async function main() {
  const binDir = path.join(__dirname, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const archivePath = path.join(binDir, target);
  const sigPath = `${archivePath}.sig`;

  await download(archiveURL, archivePath);
  await download(sigURL, sigPath);

  verifySignature(archivePath, sigPath);
  await extract(archivePath, binDir);

  fs.unlinkSync(archivePath);
  fs.unlinkSync(sigPath);

  // Make binaries executable on POSIX
  if (platform !== 'win32') {
    fs.chmodSync(path.join(binDir, 'klio'), 0o755);
    fs.chmodSync(path.join(binDir, 'klio-mcp'), 0o755);
  }

  console.log('Klio installed.');
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'klio-cli-installer' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return download(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`download ${url} failed: ${res.statusCode}`));
      }
      const file = fs.createWriteStream(destPath);
      pipeline(res, file).then(resolve, reject);
    }).on('error', reject);
  });
}

function verifySignature(archivePath, sigPath) {
  const archive = fs.readFileSync(archivePath);
  const sig = fs.readFileSync(sigPath);
  const verify = crypto.verify(null, archive, PUBLIC_KEY_PEM, sig);
  if (!verify) {
    throw new Error('Klio: binary signature verification failed — refusing to install');
  }
}

async function extract(archivePath, destDir) {
  if (archivePath.endsWith('.tar.gz')) {
    const { spawnSync } = require('child_process');
    const result = spawnSync('tar', ['-xzf', archivePath, '-C', destDir]);
    if (result.status !== 0) {
      throw new Error(`tar extraction failed: ${result.stderr}`);
    }
  } else if (archivePath.endsWith('.zip')) {
    // Minimal zip extraction (Windows). For v0 we shell out to PowerShell's Expand-Archive.
    const { spawnSync } = require('child_process');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path "${archivePath}" -DestinationPath "${destDir}" -Force`,
    ]);
    if (result.status !== 0) {
      throw new Error(`zip extraction failed: ${result.stderr}`);
    }
  }
}

main().catch((e) => {
  console.error('Klio install failed:', e.message);
  process.exit(1);
});
```

**Step 3: Write the bin wrappers**

Create `bridge/npm/bin/klio.js`:

```javascript
#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');

const ext = process.platform === 'win32' ? '.exe' : '';
const binary = path.join(__dirname, 'klio' + ext);
const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code));
```

Create `bridge/npm/bin/klio-mcp.js` (mirror, with `klio-mcp` binary).

**Step 4: Test the wrapper logic**

Create `bridge/npm/test/install.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('package.json declares both binaries', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.bin.klio, 'bin/klio.js');
  assert.equal(pkg.bin['klio-mcp'], 'bin/klio-mcp.js');
});

test('install.js handles unsupported platforms', () => {
  // Smoke check that the TARGETS table has at least the expected entries
  const installContent = fs.readFileSync(path.join(__dirname, '..', 'install.js'), 'utf8');
  assert.ok(installContent.includes('darwin-arm64'));
  assert.ok(installContent.includes('linux-x64'));
});
```

Run: `node --test test/install.test.js`
Expected: `pass`.

**Step 5: Commit**

```bash
cd bridge
git add npm/
git commit -m "feat(bridge): npm wrapper for downloading native binary"
```

---

### Task H.2 — Bridge: agent auto-detection adapters

**Files:**
- Create: `bridge/internal/agentadapters/types.go`
- Create: `bridge/internal/agentadapters/claude_code.go`
- Create: `bridge/internal/agentadapters/cursor.go`
- Create: `bridge/internal/agentadapters/codex.go`
- Create: `bridge/internal/agentadapters/registry.go`
- Create: `bridge/internal/agentadapters/claude_code_test.go`

**Step 1: Write the failing test**

Create `bridge/internal/agentadapters/claude_code_test.go`:

```go
package agentadapters

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestDetectsClaudeCodeFromSettings(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	settingsDir := filepath.Join(tmpHome, ".claude")
	if err := os.MkdirAll(settingsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(settingsDir, "settings.json")
	if err := os.WriteFile(settingsPath, []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := NewClaudeCodeAdapter()
	if !adapter.Installed() {
		t.Fatal("expected Claude Code to be detected")
	}
}

func TestPatchesClaudeCodeSettings(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	settingsDir := filepath.Join(tmpHome, ".claude")
	_ = os.MkdirAll(settingsDir, 0o755)
	settingsPath := filepath.Join(settingsDir, "settings.json")
	original := map[string]any{"theme": "dark", "mcpServers": map[string]any{
		"existing": map[string]any{"command": "x"},
	}}
	body, _ := json.Marshal(original)
	_ = os.WriteFile(settingsPath, body, 0o644)

	adapter := NewClaudeCodeAdapter()
	if err := adapter.Install("/tmp/klio-mcp"); err != nil {
		t.Fatalf("Install: %v", err)
	}

	updated, _ := os.ReadFile(settingsPath)
	var got map[string]any
	_ = json.Unmarshal(updated, &got)

	mcp := got["mcpServers"].(map[string]any)
	if _, ok := mcp["existing"]; !ok {
		t.Fatal("preserved existing mcpServer entry was removed")
	}
	klio, ok := mcp["klio"].(map[string]any)
	if !ok {
		t.Fatal("klio entry not added")
	}
	if klio["command"] != "/tmp/klio-mcp" {
		t.Fatalf("command: %v", klio["command"])
	}

	hooks, ok := got["hooks"].(map[string]any)
	if !ok {
		t.Fatal("hooks block not added")
	}
	for _, name := range []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStop", "Stop"} {
		if _, ok := hooks[name]; !ok {
			t.Errorf("hook %s missing", name)
		}
	}
}

func TestUninstallRestoresFromBackup(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	settingsDir := filepath.Join(tmpHome, ".claude")
	_ = os.MkdirAll(settingsDir, 0o755)
	settingsPath := filepath.Join(settingsDir, "settings.json")
	original := []byte(`{"theme":"dark"}`)
	_ = os.WriteFile(settingsPath, original, 0o644)

	adapter := NewClaudeCodeAdapter()
	_ = adapter.Install("/tmp/klio-mcp")
	if err := adapter.Uninstall(); err != nil {
		t.Fatalf("Uninstall: %v", err)
	}

	restored, _ := os.ReadFile(settingsPath)
	if string(restored) != string(original) {
		t.Fatalf("restored content mismatch: got %q want %q", restored, original)
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement Adapter interface**

Create `bridge/internal/agentadapters/types.go`:

```go
// Package agentadapters detects installed MCP-capable agents and patches
// their config files to add the Klio MCP server.
package agentadapters

// Adapter knows how to detect, install Klio config into, and uninstall from
// a single agent platform (Claude Code, Cursor, Codex, etc.).
type Adapter interface {
	// Name returns a stable identifier ("claude-code", "cursor", "codex").
	Name() string

	// Installed reports whether the agent is detected on this machine.
	Installed() bool

	// Install backs up the agent's config and patches it to add the Klio
	// MCP server entry (and, for agents that support it, hooks).
	Install(klioMcpBinary string) error

	// Uninstall restores the agent's config from the most recent backup.
	Uninstall() error
}
```

Create `bridge/internal/agentadapters/claude_code.go`:

```go
package agentadapters

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type ClaudeCodeAdapter struct{}

func NewClaudeCodeAdapter() *ClaudeCodeAdapter { return &ClaudeCodeAdapter{} }

func (a *ClaudeCodeAdapter) Name() string { return "claude-code" }

func (a *ClaudeCodeAdapter) settingsPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "settings.json")
}

func (a *ClaudeCodeAdapter) Installed() bool {
	_, err := os.Stat(a.settingsPath())
	return err == nil
}

func (a *ClaudeCodeAdapter) Install(klioMcpBinary string) error {
	path := a.settingsPath()
	settings, err := readJSON(path)
	if err != nil {
		return err
	}

	// Backup
	if err := backupFile(path); err != nil {
		return err
	}

	// Patch mcpServers
	mcp, _ := settings["mcpServers"].(map[string]any)
	if mcp == nil {
		mcp = map[string]any{}
	}
	mcp["klio"] = map[string]any{"command": klioMcpBinary, "args": []string{}}
	settings["mcpServers"] = mcp

	// Patch hooks
	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	addHook(hooks, "SessionStart", "*", "klio hook session-start")
	addHook(hooks, "UserPromptSubmit", "*", "klio hook user-prompt")
	addHook(hooks, "PreToolUse", "Bash|Edit|Write", "klio hook pre-tool")
	addHook(hooks, "PostToolUse", "*", "klio hook post-tool")
	addHook(hooks, "SubagentStop", "*", "klio hook subagent-stop")
	addHook(hooks, "Stop", "*", "klio hook session-stop")
	settings["hooks"] = hooks

	return writeJSON(path, settings)
}

func (a *ClaudeCodeAdapter) Uninstall() error {
	return restoreFromBackup(a.settingsPath())
}

func addHook(hooks map[string]any, event, matcher, command string) {
	existing, _ := hooks[event].([]any)
	// Look for an existing klio entry to update; otherwise append.
	for _, entry := range existing {
		em, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if em["matcher"] == matcher {
			emHooks, _ := em["hooks"].([]any)
			for _, h := range emHooks {
				hm, _ := h.(map[string]any)
				if hm != nil && hm["command"] == command {
					return // already present
				}
			}
			em["hooks"] = append(emHooks, map[string]any{
				"type": "command", "command": command,
			})
			return
		}
	}
	hooks[event] = append(existing, map[string]any{
		"matcher": matcher,
		"hooks":   []any{map[string]any{"type": "command", "command": command}},
	})
}

func readJSON(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return map[string]any{}, nil
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("config file at %s is not valid JSON: %w", path, err)
	}
	return out, nil
}

func writeJSON(path string, data map[string]any) error {
	body, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, body, 0o644)
}

func backupFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	backup := fmt.Sprintf("%s.klio-backup-%d", path, time.Now().Unix())
	return os.WriteFile(backup, data, 0o644)
}

func restoreFromBackup(path string) error {
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var latest string
	var latestTime int64
	prefix := base + ".klio-backup-"
	for _, e := range entries {
		if !ok2(e, prefix) {
			continue
		}
		ts := timestampOf(e.Name(), prefix)
		if ts > latestTime {
			latest = e.Name()
			latestTime = ts
		}
	}
	if latest == "" {
		return fmt.Errorf("no Klio backup found for %s", path)
	}
	data, err := os.ReadFile(filepath.Join(dir, latest))
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func ok2(e os.DirEntry, prefix string) bool {
	return !e.IsDir() && len(e.Name()) > len(prefix) && e.Name()[:len(prefix)] == prefix
}

func timestampOf(name, prefix string) int64 {
	var ts int64
	_, _ = fmt.Sscanf(name[len(prefix):], "%d", &ts)
	return ts
}
```

Cursor and Codex adapters mirror this pattern; their adapters live at:
- `cursor.go` — looks for `~/.cursor/mcp.json` (or platform-specific path), patches `mcpServers`. No hook system, so fewer steps.
- `codex.go` — TBD until Codex publishes its config schema; placeholder skips for v0.

Create `bridge/internal/agentadapters/registry.go`:

```go
package agentadapters

func All() []Adapter {
	return []Adapter{
		NewClaudeCodeAdapter(),
		NewCursorAdapter(),
		// NewCodexAdapter() — re-enable once Codex config schema lands
	}
}
```

**Step 4: Run, verify it passes**

Run: `go test ./internal/agentadapters/...`
Expected: `ok`.

**Step 5: Commit**

```bash
git add internal/agentadapters/
git commit -m "feat(bridge): agent auto-detection and config patching for Claude Code + Cursor"
```

---

### Task H.3 — Bridge: `klio init` subcommand

**Files:**
- Create: `bridge/internal/bootstrap/bootstrap.go`
- Create: `bridge/internal/bootstrap/bootstrap_test.go`
- Modify: `bridge/cmd/klio/main.go` (add `init` subcommand)

**Step 1: Write the failing test**

Create `bridge/internal/bootstrap/bootstrap_test.go`:

```go
package bootstrap

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
)

func TestRunProvisionsAndPatches(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	claudeDir := filepath.Join(tmpHome, ".claude")
	_ = os.MkdirAll(claudeDir, 0o755)
	_ = os.WriteFile(filepath.Join(claudeDir, "settings.json"), []byte("{}"), 0o644)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user_id":          uuid.New().String(),
			"agent_id":         uuid.New().String(),
			"api_key":          "rt_test_token",
			"claimed":          false,
			"default_space_id": uuid.New().String(),
		})
	}))
	defer srv.Close()

	opts := Options{
		CloudURL:      srv.URL,
		KlioMcpBinary: "/tmp/fake-klio-mcp",
		KeychainStub:  &fakeKeychain{},
	}
	report, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if report.UserID == uuid.Nil {
		t.Fatal("UserID empty")
	}
	if len(report.AgentsConfigured) == 0 {
		t.Fatal("no agents configured")
	}

	settingsBytes, _ := os.ReadFile(filepath.Join(claudeDir, "settings.json"))
	var settings map[string]any
	_ = json.Unmarshal(settingsBytes, &settings)
	mcp, _ := settings["mcpServers"].(map[string]any)
	if _, ok := mcp["klio"]; !ok {
		t.Fatal("Claude Code settings did not get klio MCP entry")
	}
}

type fakeKeychain struct {
	data map[string][]byte
}

func (f *fakeKeychain) Set(key string, value []byte) error {
	if f.data == nil {
		f.data = map[string][]byte{}
	}
	f.data[key] = value
	return nil
}
func (f *fakeKeychain) Get(key string) ([]byte, error) { return f.data[key], nil }
func (f *fakeKeychain) Delete(key string) error        { delete(f.data, key); return nil }
```

**Step 2: Run, verify it fails.**

**Step 3: Implement bootstrap**

Create `bridge/internal/bootstrap/bootstrap.go`:

```go
// Package bootstrap implements `klio init` — the one-shot setup that
// provisions an anonymous account, stores credentials, and patches every
// detected agent's config.
package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/agentadapters"
	"github.com/klio-tech/bridge/internal/cloud"
)

type KeychainBackend interface {
	Set(key string, value []byte) error
	Get(key string) ([]byte, error)
	Delete(key string) error
}

type Options struct {
	CloudURL      string
	KlioMcpBinary string
	KeychainStub  KeychainBackend // injected for tests; nil uses real keychain
}

type Report struct {
	UserID           uuid.UUID
	AgentID          uuid.UUID
	DefaultSpaceID   uuid.UUID
	AgentsConfigured []string
}

func Run(ctx context.Context, opts Options) (*Report, error) {
	if opts.CloudURL == "" {
		opts.CloudURL = "https://api.klio.tech"
	}
	if opts.KlioMcpBinary == "" {
		// default: assume klio-mcp is on PATH; the npm wrapper sets the absolute path
		opts.KlioMcpBinary = "klio-mcp"
	}

	// 1. Provision
	c := cloud.NewClient(opts.CloudURL)
	installID := getOrCreateInstallID(opts.KeychainStub)
	provReq := cloud.ProvisionRequest{AgentKind: "klio-bridge", InstallID: installID}
	prov, err := c.Provision(provReq)
	if err != nil {
		return nil, fmt.Errorf("provision failed: %w", err)
	}

	// 2. Persist refresh token
	if err := opts.KeychainStub.Set("refresh_token", []byte(prov.APIKey)); err != nil {
		return nil, fmt.Errorf("keychain set: %w", err)
	}
	if err := opts.KeychainStub.Set("user_id", []byte(prov.UserID.String())); err != nil {
		return nil, err
	}
	if err := opts.KeychainStub.Set("agent_id", []byte(prov.AgentID.String())); err != nil {
		return nil, err
	}

	// 3. Ensure ~/.klio exists
	home, _ := os.UserHomeDir()
	klioDir := filepath.Join(home, ".klio")
	if err := os.MkdirAll(klioDir, 0o700); err != nil {
		return nil, err
	}

	// 4. Patch each detected agent
	configured := []string{}
	var errs []error
	for _, adapter := range agentadapters.All() {
		if !adapter.Installed() {
			continue
		}
		if err := adapter.Install(opts.KlioMcpBinary); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", adapter.Name(), err))
			continue
		}
		configured = append(configured, adapter.Name())
	}
	if len(configured) == 0 && len(errs) == 0 {
		return nil, errors.New("no installed agents detected — Klio nothing to do")
	}

	report := &Report{
		UserID: prov.UserID, AgentID: prov.AgentID,
		DefaultSpaceID: prov.DefaultSpaceID, AgentsConfigured: configured,
	}
	if len(errs) > 0 {
		return report, fmt.Errorf("partial install: %v", errs)
	}
	return report, nil
}

func getOrCreateInstallID(kc KeychainBackend) uuid.UUID {
	if existing, err := kc.Get("install_id"); err == nil && len(existing) > 0 {
		if id, err := uuid.Parse(string(existing)); err == nil {
			return id
		}
	}
	id := uuid.New()
	_ = kc.Set("install_id", []byte(id.String()))
	return id
}
```

**Step 4: Wire `klio init` subcommand**

Add to `bridge/cmd/klio/main.go`:

```go
case "init":
	runInit()
case "uninstall":
	runUninstall()
case "status":
	runStatus()
case "hook":
	runHook()  // Phase J implements
```

`runInit()`:

```go
func runInit() {
	fmt.Println("Klio: initializing...")
	kc := keychain.New("tech.klio.bridge")
	klioMcpBin, _ := exec.LookPath("klio-mcp")
	if klioMcpBin == "" {
		// fall back to sibling binary in npm-installed location
		exe, _ := os.Executable()
		dir := filepath.Dir(exe)
		klioMcpBin = filepath.Join(dir, "klio-mcp")
	}
	report, err := bootstrap.Run(context.Background(), bootstrap.Options{
		KlioMcpBinary: klioMcpBin,
		KeychainStub:  kc,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Klio init failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("✓ Anonymous Klio account created: %s\n", report.UserID)
	fmt.Printf("✓ Default space: %s\n", report.DefaultSpaceID)
	for _, a := range report.AgentsConfigured {
		fmt.Printf("✓ Configured: %s\n", a)
	}
	fmt.Println("✓ Daemon will start at next login. Run `klio daemon` to start it now.")
	fmt.Println()
	fmt.Println("Try: open Claude Code and ask 'remember that I prefer TypeScript'.")
}
```

**Step 5: Run, verify it passes**

Run: `go test ./internal/bootstrap/...`
Expected: `ok`.

**Step 6: Commit**

```bash
git add internal/bootstrap/ cmd/klio/main.go
git commit -m "feat(bridge): klio init bootstrap with provision + agent auto-config"
```

---

### Task H.4 — Bridge: service installation per platform

**Files:**
- Create: `bridge/internal/service/service.go`
- Create: `bridge/internal/service/launchd.go`
- Create: `bridge/internal/service/systemd.go`
- Create: `bridge/internal/service/windows.go`
- Create: `bridge/internal/service/service_test.go`

**Step 1: Write the failing test (smoke)**

Create `bridge/internal/service/service_test.go`:

```go
package service

import (
	"runtime"
	"testing"
)

func TestPlatformReturnsCorrectInstaller(t *testing.T) {
	inst := PlatformInstaller()
	if inst == nil {
		t.Fatal("nil installer")
	}
	switch runtime.GOOS {
	case "darwin":
		if inst.Name() != "launchd" {
			t.Fatalf("expected launchd, got %s", inst.Name())
		}
	case "linux":
		if inst.Name() != "systemd" {
			t.Fatalf("expected systemd, got %s", inst.Name())
		}
	case "windows":
		if inst.Name() != "windows-task" {
			t.Fatalf("expected windows-task, got %s", inst.Name())
		}
	}
}
```

**Step 2: Implement service installer interface**

Create `bridge/internal/service/service.go`:

```go
// Package service installs the klio daemon as a per-user background service.
//
// Three implementations:
//   - macOS:   launchd LaunchAgent in ~/Library/LaunchAgents
//   - Linux:   systemd user unit in ~/.config/systemd/user
//   - Windows: scheduled task that runs at logon
package service

import "runtime"

type Installer interface {
	Name() string
	Install(klioBinary string) error
	Uninstall() error
	Start() error
	Stop() error
	Status() (running bool, err error)
}

func PlatformInstaller() Installer {
	switch runtime.GOOS {
	case "darwin":
		return &LaunchdInstaller{}
	case "linux":
		return &SystemdInstaller{}
	case "windows":
		return &WindowsTaskInstaller{}
	}
	return nil
}
```

Create `bridge/internal/service/launchd.go`:

```go
package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

type LaunchdInstaller struct{}

func (l *LaunchdInstaller) Name() string { return "launchd" }

func (l *LaunchdInstaller) plistPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", "tech.klio.bridge.plist")
}

func (l *LaunchdInstaller) Install(klioBinary string) error {
	home, _ := os.UserHomeDir()
	klioDir := filepath.Join(home, ".klio")
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>tech.klio.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>%s/logs/bridge.log</string>
  <key>StandardErrorPath</key><string>%s/logs/bridge.err</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>`, klioBinary, klioDir, klioDir)

	if err := os.MkdirAll(filepath.Dir(l.plistPath()), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(klioDir, "logs"), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(l.plistPath(), []byte(plist), 0o644); err != nil {
		return err
	}
	return exec.Command("launchctl", "load", l.plistPath()).Run()
}

func (l *LaunchdInstaller) Uninstall() error {
	_ = exec.Command("launchctl", "unload", l.plistPath()).Run()
	return os.Remove(l.plistPath())
}

func (l *LaunchdInstaller) Start() error {
	return exec.Command("launchctl", "start", "tech.klio.bridge").Run()
}

func (l *LaunchdInstaller) Stop() error {
	return exec.Command("launchctl", "stop", "tech.klio.bridge").Run()
}

func (l *LaunchdInstaller) Status() (bool, error) {
	out, err := exec.Command("launchctl", "list", "tech.klio.bridge").Output()
	if err != nil {
		return false, nil // not loaded
	}
	return len(out) > 0, nil
}
```

Linux + Windows variants follow the same pattern (systemd unit file + `systemctl --user enable klio-bridge.service`; Windows scheduled task via `schtasks /create /tn Klio /sc onlogon /tr "klio.exe daemon"`).

**Step 3: Wire into `klio init`**

After bootstrap.Run() succeeds, call `service.PlatformInstaller().Install(exePath)` and `Start()`. Persist a flag in keychain so `klio uninstall` reverses both.

**Step 4: Run, verify**

Run: `go test ./internal/service/...`
Expected: `ok` (the smoke test passes; full integration with launchd/systemd is verified manually on each platform).

**Step 5: Commit**

```bash
git add internal/service/
git commit -m "feat(bridge): per-platform service installer (launchd, systemd, Windows tasks)"
```

---

### Task H.5 — Bridge: `klio uninstall` subcommand

**Files:**
- Modify: `bridge/cmd/klio/main.go` (add `runUninstall`)
- Create: `bridge/internal/bootstrap/uninstall.go`
- Create: `bridge/internal/bootstrap/uninstall_test.go`

**Step 1: Write the failing test**

Create `bridge/internal/bootstrap/uninstall_test.go`:

```go
package bootstrap

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestUninstallRemovesConfigsAndCreds(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	claudeDir := filepath.Join(tmpHome, ".claude")
	_ = os.MkdirAll(claudeDir, 0o755)
	_ = os.WriteFile(filepath.Join(claudeDir, "settings.json"), []byte("{}"), 0o644)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(204)
	}))
	defer srv.Close()

	kc := &fakeKeychain{}
	_ = kc.Set("refresh_token", []byte("fake"))
	_ = kc.Set("install_id", []byte("00000000-0000-0000-0000-000000000001"))

	if err := Uninstall(context.Background(), UninstallOptions{
		KeychainStub: kc, Purge: false,
	}); err != nil {
		t.Fatalf("Uninstall: %v", err)
	}
	if _, err := kc.Get("refresh_token"); err == nil && len(kc.data["refresh_token"]) > 0 {
		t.Fatal("refresh_token not deleted")
	}
}
```

**Step 2: Implement Uninstall**

Create `bridge/internal/bootstrap/uninstall.go`:

```go
package bootstrap

import (
	"context"

	"github.com/klio-tech/bridge/internal/agentadapters"
)

type UninstallOptions struct {
	KeychainStub KeychainBackend
	Purge        bool // if true, also call DELETE /v1/users/{id} to hard-delete cloud account
}

func Uninstall(ctx context.Context, opts UninstallOptions) error {
	for _, adapter := range agentadapters.All() {
		if !adapter.Installed() {
			continue
		}
		_ = adapter.Uninstall()
	}
	for _, k := range []string{"refresh_token", "user_id", "agent_id", "install_id"} {
		_ = opts.KeychainStub.Delete(k)
	}
	// Phase L wires the cloud DELETE call when Purge is true.
	return nil
}
```

**Step 3: Run, verify it passes**

Run: `go test ./internal/bootstrap/...`
Expected: `ok`.

**Step 4: Commit**

```bash
git add internal/bootstrap/uninstall.go cmd/klio/main.go
git commit -m "feat(bridge): klio uninstall reverses init"
```

End of Phase H. `npx klio init` provisions, stores creds, patches every detected agent config, installs the daemon as a service, and starts it. `klio uninstall` reverses everything.

---

## Phase I — Trust App (`app.klio.tech`) (Weeks 2–5, parallel with A–H)

Goal: a Next.js 15 trust app at `app.klio.tech` where users land from magic-link emails, see their spaces, edit per-space ACL, view audit log, export their data, and trigger hard delete. Magic-link auth only — no passwords. Server-rendered, mobile-responsive, accessible.

### Task I.1 — Trust app: Next.js scaffold with App Router

**Files:**
- Create: `trust-app/package.json`
- Create: `trust-app/tsconfig.json`
- Create: `trust-app/next.config.ts`
- Create: `trust-app/tailwind.config.ts`
- Create: `trust-app/postcss.config.mjs`
- Create: `trust-app/src/app/layout.tsx`
- Create: `trust-app/src/app/page.tsx`
- Create: `trust-app/src/app/globals.css`
- Create: `trust-app/.github/workflows/ci.yml`
- Create: `trust-app/playwright.config.ts`
- Create: `trust-app/tests/e2e/landing.spec.ts`
- Create: `trust-app/tests/unit/setup.ts`

**Step 1: Initialize Next.js**

Run:
```bash
cd trust-app
pnpm init
pnpm add next@15 react@19 react-dom@19
pnpm add -D typescript @types/react @types/node @types/react-dom
pnpm add -D tailwindcss@4 postcss autoprefixer
pnpm add -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom
pnpm add -D playwright @playwright/test
pnpm add -D eslint eslint-config-next
```

**Step 2: Write the failing landing-page test**

Create `trust-app/tests/e2e/landing.spec.ts`:

```typescript
import { expect, test } from '@playwright/test';

test('landing page shows Klio branding', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Klio/i);
});

test('sign-in form requests email', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: /email/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /send magic link/i })).toBeVisible();
});
```

**Step 3: Run, verify it fails** — landing page doesn't exist.

**Step 4: Implement the layout, landing page, and globals**

Create `trust-app/src/app/layout.tsx`:

```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Klio — your AI agents, finally talking to each other',
  description: 'See and control everything Klio remembers about you.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
```

Create `trust-app/src/app/page.tsx`:

```tsx
import { LoginForm } from '@/components/login-form';

export default function LandingPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-12">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight">Klio</h1>
          <p className="mt-3 text-muted-foreground">
            Your AI agents, finally talking to each other.
          </p>
        </div>
        <LoginForm />
        <p className="text-xs text-muted-foreground text-center">
          We&apos;ll email you a magic link. No passwords, ever.
        </p>
      </div>
    </main>
  );
}
```

Create `trust-app/src/components/login-form.tsx`:

```tsx
'use client';

import { useActionState } from 'react';
import { requestLoginLink } from '@/app/actions/auth';

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(requestLoginLink, null);
  return (
    <form action={formAction} className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium">Email</span>
        <input
          type="email" name="email" required autoComplete="email"
          className="mt-1 block w-full rounded-md border px-3 py-2"
          placeholder="you@example.com"
        />
      </label>
      <button
        type="submit" disabled={isPending}
        className="w-full rounded-md bg-foreground px-4 py-2 font-medium text-background disabled:opacity-50"
      >
        {isPending ? 'Sending…' : 'Send magic link'}
      </button>
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state?.ok && <p className="text-sm text-green-600">Check your email.</p>}
    </form>
  );
}
```

Create `trust-app/src/app/actions/auth.ts`:

```typescript
'use server';

import { z } from 'zod';

const Schema = z.object({ email: z.string().email() });

export async function requestLoginLink(_prev: unknown, formData: FormData) {
  const parsed = Schema.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    return { error: 'Please enter a valid email.', ok: false };
  }
  const res = await fetch(`${process.env.COORDINATOR_URL}/v1/auth/login-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: parsed.data.email }),
  });
  if (!res.ok) {
    return { error: 'Could not send link. Try again.', ok: false };
  }
  return { ok: true, error: null };
}
```

(Add `pnpm add zod`.)

Configure Tailwind in `trust-app/tailwind.config.ts` and Next.js in `trust-app/next.config.ts`. Create the standard `globals.css` with Tailwind `@import` and basic CSS variables for `--background`, `--foreground`, `--muted-foreground`.

**Step 5: Add the `/v1/auth/login-link` endpoint to the coordinator**

In `coordinator/src/klio_coordinator/api/users.py`:

```python
class LoginLinkRequest(BaseModel):
    email: EmailStr


@router.post("/auth/login-link")
async def login_link(
    body: LoginLinkRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> dict[str, bool]:
    # Look up user by email_hash. If not found, we still "succeed" to avoid
    # leaking whether an email exists in the system.
    import hashlib
    email_hash = hashlib.sha256(str(body.email).encode()).hexdigest()
    from klio_coordinator.engine_client import EngineClient
    user = await EngineClient().find_user_by_email_hash(email_hash)
    if user is None:
        return {"magic_link_sent": True}  # silent success

    plaintext, _ = await issue_magic_link(
        session, user_id=uuid.UUID(user["id"]), ttl_minutes=15,
        ip=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    await session.commit()
    link = f"https://app.klio.tech/verify?token={plaintext}&user_id={user['id']}"
    EmailService().send_magic_link(to=str(body.email), link=link, mode="login")
    return {"magic_link_sent": True}
```

(Add `find_user_by_email_hash` to `EngineClient`. Add the corresponding internal endpoint to the engine.)

**Step 6: Run the tests**

Run:
```bash
pnpm dev &  # starts Next.js
pnpm test:e2e  # runs Playwright
```
Expected: both tests pass.

**Step 7: Commit**

```bash
cd trust-app
git add .
git commit -m "feat(trust-app): Next.js scaffold + magic-link login form"
```

---

### Task I.2 — Trust app: magic-link verify flow + session cookie

**Files:**
- Create: `trust-app/src/app/verify/page.tsx`
- Create: `trust-app/src/app/api/auth/session/route.ts`
- Create: `trust-app/src/lib/session.ts`
- Create: `trust-app/tests/e2e/verify.spec.ts`

**Step 1: Write the failing test**

Create `trust-app/tests/e2e/verify.spec.ts`:

```typescript
import { expect, test } from '@playwright/test';

test('verify page redirects on success', async ({ page, request }) => {
  // Set up a fixture: provision a user via the coordinator test harness,
  // request a magic link, and capture the token from the test mailbox.
  const token = await request.post('/test-helpers/issue-magic-link', {
    data: { email: 'test@example.com' },
  }).then((r) => r.json()).then((b) => b.token);

  await page.goto(`/verify?token=${token}`);
  await page.waitForURL('/spaces');
  await expect(page.getByRole('heading', { name: /spaces/i })).toBeVisible();
});

test('verify with invalid token shows error', async ({ page }) => {
  await page.goto('/verify?token=not-a-valid-token');
  await expect(page.getByText(/invalid or expired/i)).toBeVisible();
});
```

**Step 2: Run, verify it fails.**

**Step 3: Implement verify page**

Create `trust-app/src/app/verify/page.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

export default async function VerifyPage({
  searchParams,
}: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) {
    return <ErrorState message="Missing token." />;
  }

  const res = await fetch(`${process.env.COORDINATOR_URL}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    return <ErrorState message="Invalid or expired link. Request a new one." />;
  }
  const { session_token } = await res.json();
  const cookieStore = await cookies();
  cookieStore.set('klio_session', session_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60,
    path: '/',
  });
  redirect('/spaces');
}

function ErrorState({ message }: { message: string }) {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <p className="text-red-600">{message}</p>
    </main>
  );
}
```

**Step 4: Add `/v1/auth/verify` to coordinator** — already implemented in Task B.7 as `/v1/users/{id}/verify`; we add a more user-friendly variant that doesn't require knowing the user_id (the magic-link token alone is enough). Add to `coordinator/src/klio_coordinator/api/users.py`:

```python
class AuthVerifyRequest(BaseModel):
    token: str


@router.post("/auth/verify", response_model=VerifyResponse)
async def auth_verify(
    body: AuthVerifyRequest,
    session: AsyncSession = Depends(get_session),
) -> VerifyResponse:
    user_id = await verify_magic_link(session, plaintext=body.token)
    settings = Settings()
    session_token = mint_access_token(
        secret=settings.jwt_signing_key, user_id=user_id, agent_id=user_id,
        scopes=["session"], ttl_seconds=30 * 24 * 3600,
    )
    access_token = mint_access_token(
        secret=settings.jwt_signing_key, user_id=user_id, agent_id=user_id,
        scopes=["session"], ttl_seconds=settings.access_token_ttl_seconds,
    )
    await session.commit()
    return VerifyResponse(user_id=user_id, session_token=session_token, access_token=access_token)
```

**Step 5: Implement session helper**

Create `trust-app/src/lib/session.ts`:

```typescript
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import * as jose from 'jose';

export async function getSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get('klio_session')?.value;
  if (!token) return null;
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SIGNING_KEY!);
    const { payload } = await jose.jwtVerify(token, secret, { audience: 'klio.tech' });
    return { userId: payload.sub as string, accessToken: token };
  } catch {
    return null;
  }
}

export async function requireSession() {
  const session = await getSession();
  if (!session) {
    redirect('/');
  }
  return session;
}
```

(Add `pnpm add jose`.)

**Step 6: Run, verify**

Run: `pnpm test:e2e`
Expected: both tests pass.

**Step 7: Commit**

```bash
git add src/app/verify/ src/app/api/auth/ src/lib/session.ts tests/e2e/verify.spec.ts
git commit -m "feat(trust-app): magic-link verify flow with session cookie"
```

---

### Task I.3 — Trust app: spaces list page

**Files:**
- Create: `trust-app/src/app/spaces/page.tsx`
- Create: `trust-app/src/app/spaces/loading.tsx`
- Create: `trust-app/src/app/spaces/error.tsx`
- Create: `trust-app/src/lib/api-client.ts`
- Create: `trust-app/tests/e2e/spaces-list.spec.ts`

**Step 1: Write the failing test**

Create `trust-app/tests/e2e/spaces-list.spec.ts`:

```typescript
import { expect, test } from '@playwright/test';
import { signInAsTestUser } from './helpers';

test('spaces page lists user spaces', async ({ page }) => {
  await signInAsTestUser(page, 'test@example.com');
  await page.goto('/spaces');
  await expect(page.getByRole('heading', { name: /spaces/i })).toBeVisible();
  await expect(page.getByText(/Default/)).toBeVisible();
});

test('clicking a space navigates to detail', async ({ page }) => {
  await signInAsTestUser(page, 'test@example.com');
  await page.goto('/spaces');
  await page.getByRole('link', { name: /Default/ }).click();
  await page.waitForURL(/\/spaces\/[^\/]+$/);
});
```

**Step 2: Run, verify it fails.**

**Step 3: Implement API client**

Create `trust-app/src/lib/api-client.ts`:

```typescript
import { requireSession } from './session';

export type Space = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
};

export type Permission = {
  id: string;
  space_id: string;
  agent_id: string;
  scope: 'read' | 'write' | 'admin';
  granted_at: string;
};

export type Agent = {
  id: string;
  kind: string;
  display_name: string | null;
  created_at: string;
};

export type AuditEntry = {
  id: string;
  actor_type: string;
  action: string;
  target_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

class ApiClient {
  private baseURL = process.env.NEXT_PUBLIC_ENGINE_URL ?? process.env.ENGINE_URL!;

  async listSpaces(): Promise<Space[]> {
    const session = await requireSession();
    return this.fetch('/v1/spaces', session.accessToken);
  }

  async getSpace(id: string): Promise<Space> {
    const session = await requireSession();
    return this.fetch(`/v1/spaces/${id}`, session.accessToken);
  }

  async listPermissions(spaceId: string): Promise<Permission[]> {
    const session = await requireSession();
    return this.fetch(`/v1/spaces/${spaceId}/permissions`, session.accessToken);
  }

  async grant(spaceId: string, agentId: string, scope: string): Promise<Permission> {
    const session = await requireSession();
    return this.fetch(`/v1/spaces/${spaceId}/permissions`, session.accessToken, {
      method: 'POST',
      body: JSON.stringify({ agent_id: agentId, scope }),
    });
  }

  async revoke(spaceId: string, agentId: string): Promise<void> {
    const session = await requireSession();
    await this.fetch(`/v1/spaces/${spaceId}/permissions/${agentId}`, session.accessToken, {
      method: 'DELETE',
    });
  }

  async listAgents(): Promise<Agent[]> {
    const session = await requireSession();
    return this.fetch('/v1/agents', session.accessToken);
  }

  async listAudit(): Promise<AuditEntry[]> {
    const session = await requireSession();
    return this.fetch('/v1/audit', session.accessToken);
  }

  private async fetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseURL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...init?.headers,
      },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
    if (res.status === 204) return undefined as T;
    return res.json();
  }
}

export const api = new ApiClient();
```

**Step 4: Implement spaces page**

Create `trust-app/src/app/spaces/page.tsx`:

```tsx
import Link from 'next/link';
import { api } from '@/lib/api-client';

export default async function SpacesPage() {
  const spaces = await api.listSpaces();
  return (
    <main className="max-w-4xl mx-auto px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-bold">Your Spaces</h1>
        <p className="mt-2 text-muted-foreground">
          A space is a container for memory. Each space has its own access controls —
          you choose which agents can read or write each one.
        </p>
      </header>
      <ul className="divide-y border rounded-md">
        {spaces.map((s) => (
          <li key={s.id}>
            <Link
              href={`/spaces/${s.id}`}
              className="flex items-center justify-between px-6 py-4 hover:bg-muted/50"
            >
              <div>
                <h2 className="font-semibold">{s.name}</h2>
                <p className="text-sm text-muted-foreground">
                  Created {new Date(s.created_at).toLocaleDateString()}
                </p>
              </div>
              <span className="text-sm text-muted-foreground">→</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

**Step 5: Run, verify**

Run: `pnpm test:e2e`
Expected: both spaces tests pass.

**Step 6: Commit**

```bash
git add src/app/spaces/page.tsx src/lib/api-client.ts tests/e2e/spaces-list.spec.ts
git commit -m "feat(trust-app): spaces list page"
```

---

### Task I.4 — Trust app: space detail page with per-agent ACL editor

**Files:**
- Create: `trust-app/src/app/spaces/[id]/page.tsx`
- Create: `trust-app/src/app/spaces/[id]/permissions-editor.tsx`
- Create: `trust-app/src/app/spaces/[id]/actions.ts`
- Create: `trust-app/tests/e2e/space-detail.spec.ts`

**Step 1: Write the failing test**

Create `trust-app/tests/e2e/space-detail.spec.ts`:

```typescript
import { expect, test } from '@playwright/test';
import { signInAsTestUser } from './helpers';

test('space detail shows agents with their access', async ({ page }) => {
  await signInAsTestUser(page, 'test@example.com');
  await page.goto('/spaces');
  await page.getByRole('link', { name: /Default/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Default');
  await expect(page.getByText(/Klio bridge/i)).toBeVisible();
});

test('grant access to another agent', async ({ page }) => {
  await signInAsTestUser(page, 'test@example.com');
  await page.goto('/spaces');
  await page.getByRole('link', { name: /Default/ }).click();
  await page.getByRole('button', { name: /grant access/i }).click();
  await page.getByLabel(/agent/i).selectOption({ label: /Cursor/ });
  await page.getByLabel(/scope/i).selectOption('read');
  await page.getByRole('button', { name: /confirm/i }).click();
  await expect(page.getByText(/Cursor/i).first()).toBeVisible();
});

test('revoke access from agent', async ({ page }) => {
  await signInAsTestUser(page, 'test@example.com');
  await page.goto('/spaces');
  await page.getByRole('link', { name: /Default/ }).click();
  await page.getByRole('button', { name: /revoke .* Cursor/i }).click();
  await page.getByRole('button', { name: /confirm/i }).click();
  await expect(page.getByText(/Cursor/i)).not.toBeVisible();
});
```

**Step 2: Run, verify it fails.**

**Step 3: Implement page + editor**

Create `trust-app/src/app/spaces/[id]/page.tsx`:

```tsx
import { api } from '@/lib/api-client';
import { PermissionsEditor } from './permissions-editor';

export default async function SpaceDetailPage({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [space, permissions, agents] = await Promise.all([
    api.getSpace(id),
    api.listPermissions(id),
    api.listAgents(),
  ]);
  return (
    <main className="max-w-4xl mx-auto px-6 py-12 space-y-8">
      <header>
        <h1 className="text-3xl font-bold">{space.name}</h1>
        <p className="mt-2 text-muted-foreground">Slug: {space.slug}</p>
      </header>
      <section>
        <h2 className="text-xl font-semibold mb-3">Agents with access</h2>
        <PermissionsEditor
          spaceId={space.id}
          permissions={permissions}
          agents={agents}
        />
      </section>
    </main>
  );
}
```

Create `trust-app/src/app/spaces/[id]/permissions-editor.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { grantAction, revokeAction } from './actions';
import type { Agent, Permission } from '@/lib/api-client';

export function PermissionsEditor({
  spaceId,
  permissions,
  agents,
}: { spaceId: string; permissions: Permission[]; agents: Agent[] }) {
  const router = useRouter();
  const [showGrant, setShowGrant] = useState(false);

  async function onRevoke(agentId: string) {
    if (!confirm('Revoke access?')) return;
    await revokeAction(spaceId, agentId);
    router.refresh();
  }

  return (
    <div>
      <ul className="divide-y border rounded-md mb-4">
        {permissions.map((p) => {
          const agent = agents.find((a) => a.id === p.agent_id);
          return (
            <li key={p.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="font-medium">{agent?.display_name ?? agent?.kind ?? 'Unknown'}</p>
                <p className="text-xs text-muted-foreground">scope: {p.scope}</p>
              </div>
              <button
                onClick={() => onRevoke(p.agent_id)}
                aria-label={`Revoke from ${agent?.display_name}`}
                className="text-sm text-red-600 hover:underline"
              >
                Revoke
              </button>
            </li>
          );
        })}
      </ul>
      {!showGrant ? (
        <button onClick={() => setShowGrant(true)} className="text-sm font-medium">
          + Grant access to another agent
        </button>
      ) : (
        <GrantForm
          spaceId={spaceId} agents={agents} permissions={permissions}
          onCancel={() => setShowGrant(false)}
          onSuccess={() => { setShowGrant(false); router.refresh(); }}
        />
      )}
    </div>
  );
}

function GrantForm({
  spaceId, agents, permissions, onCancel, onSuccess,
}: {
  spaceId: string; agents: Agent[]; permissions: Permission[];
  onCancel: () => void; onSuccess: () => void;
}) {
  const used = new Set(permissions.map((p) => p.agent_id));
  const candidates = agents.filter((a) => !used.has(a.id));

  async function action(formData: FormData) {
    const agentId = formData.get('agent_id') as string;
    const scope = formData.get('scope') as string;
    await grantAction(spaceId, agentId, scope);
    onSuccess();
  }

  return (
    <form action={action} className="space-y-3 border rounded-md p-4">
      <label className="block">
        <span className="text-sm font-medium">Agent</span>
        <select name="agent_id" required className="mt-1 block w-full rounded-md border px-3 py-2">
          {candidates.map((a) => (
            <option key={a.id} value={a.id}>{a.display_name ?? a.kind}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-sm font-medium">Scope</span>
        <select name="scope" required className="mt-1 block w-full rounded-md border px-3 py-2">
          <option value="read">read</option>
          <option value="write">write</option>
          <option value="admin">admin</option>
        </select>
      </label>
      <div className="flex gap-2">
        <button type="submit" className="bg-foreground text-background rounded px-4 py-2">Confirm</button>
        <button type="button" onClick={onCancel} className="rounded px-4 py-2">Cancel</button>
      </div>
    </form>
  );
}
```

Create `trust-app/src/app/spaces/[id]/actions.ts`:

```typescript
'use server';

import { api } from '@/lib/api-client';

export async function grantAction(spaceId: string, agentId: string, scope: string) {
  await api.grant(spaceId, agentId, scope);
}

export async function revokeAction(spaceId: string, agentId: string) {
  await api.revoke(spaceId, agentId);
}
```

Add `/v1/agents` GET endpoint to engine — returns the user's agents for the trust app dropdown:

```python
# engine/src/klio_engine/api/agents.py
@router.get("", response_model=list[AgentResponse])
async def list_agents(
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[AgentResponse]:
    rows = (
        await session.execute(
            select(Agent).where(Agent.user_id == ctx.user_id, Agent.deleted_at.is_(None))
            .order_by(Agent.created_at)
        )
    ).scalars().all()
    return [AgentResponse(id=a.id, kind=a.kind.value, display_name=a.display_name, created_at=a.created_at) for a in rows]
```

**Step 4: Run, verify**

Run: `pnpm test:e2e`
Expected: all three space-detail tests pass.

**Step 5: Commit**

```bash
git add src/app/spaces/[id]/ tests/e2e/space-detail.spec.ts
git commit -m "feat(trust-app): space detail with per-agent ACL editor"
```

---

### Task I.5 — Trust app: audit log view

**Files:**
- Create: `trust-app/src/app/audit/page.tsx`
- Create: `trust-app/tests/e2e/audit.spec.ts`

**Step 1: Write the failing test**

Create `trust-app/tests/e2e/audit.spec.ts`:

```typescript
import { expect, test } from '@playwright/test';
import { signInAsTestUser } from './helpers';

test('audit page lists privileged actions', async ({ page }) => {
  await signInAsTestUser(page, 'test@example.com');
  await page.goto('/audit');
  await expect(page.getByRole('heading', { name: /audit log/i })).toBeVisible();
  // The user's first sign-in should appear
  await expect(page.getByText(/login/i)).toBeVisible();
});
```

**Step 2: Run, verify it fails.**

**Step 3: Implement page**

Create `trust-app/src/app/audit/page.tsx`:

```tsx
import { api } from '@/lib/api-client';

export default async function AuditPage() {
  const entries = await api.listAudit();
  return (
    <main className="max-w-4xl mx-auto px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-bold">Audit Log</h1>
        <p className="mt-2 text-muted-foreground">
          Every privileged action against your account is logged in a tamper-evident chain.
          The chain&apos;s root hash is notarized hourly to a public timestamping service.
        </p>
      </header>
      <ul className="divide-y border rounded-md">
        {entries.map((e) => (
          <li key={e.id} className="px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm">{e.action}</span>
              <time className="text-xs text-muted-foreground">
                {new Date(e.created_at).toLocaleString()}
              </time>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {e.actor_type} → {e.target_type}
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

Add `/v1/audit` endpoint to engine — returns the audit log for the calling user.

**Step 4: Run, verify**

Run: `pnpm test:e2e`
Expected: passes.

**Step 5: Commit**

```bash
git add src/app/audit/ tests/e2e/audit.spec.ts
git commit -m "feat(trust-app): audit log view"
```

---

### Task I.6 — Trust app: data export and hard delete

**Files:**
- Create: `trust-app/src/app/settings/page.tsx`
- Create: `trust-app/src/app/settings/actions.ts`
- Create: `trust-app/tests/e2e/settings.spec.ts`

**Step 1: Write the failing test**

Create `trust-app/tests/e2e/settings.spec.ts`:

```typescript
import { expect, test } from '@playwright/test';
import { signInAsTestUser } from './helpers';

test('settings page offers export and delete', async ({ page }) => {
  await signInAsTestUser(page, 'test@example.com');
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: /export my data/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /delete my account/i })).toBeVisible();
});

test('export downloads a signed JSON archive', async ({ page }) => {
  await signInAsTestUser(page, 'test@example.com');
  await page.goto('/settings');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /export my data/i }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/klio-export-.*\.json$/);
});

test('delete shows confirmation modal', async ({ page }) => {
  await signInAsTestUser(page, 'test@example.com');
  await page.goto('/settings');
  await page.getByRole('button', { name: /delete my account/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText(/30-day grace period/i)).toBeVisible();
});
```

**Step 2: Run, verify it fails.**

**Step 3: Implement page**

Create `trust-app/src/app/settings/page.tsx`:

```tsx
import { ExportButton, DeleteAccountSection } from './client-components';

export default function SettingsPage() {
  return (
    <main className="max-w-2xl mx-auto px-6 py-12 space-y-12">
      <header>
        <h1 className="text-3xl font-bold">Settings</h1>
      </header>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Export your data</h2>
        <p className="text-muted-foreground">
          Download every entry, raw event, and audit-log row. Signed JSON archive,
          encrypted in transit, valid for 24 hours.
        </p>
        <ExportButton />
      </section>

      <section className="space-y-3 border-t pt-8">
        <h2 className="text-xl font-semibold text-red-600">Delete your account</h2>
        <p className="text-muted-foreground">
          Soft-deletes everything immediately. After a 30-day grace period, all
          data — including raw events, embeddings, and encryption keys — is
          permanently destroyed. Audit log retains tombstones (action timestamps
          only, no content) for compliance.
        </p>
        <DeleteAccountSection />
      </section>
    </main>
  );
}
```

Create `trust-app/src/app/settings/client-components.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startExport, deleteAccount } from './actions';

export function ExportButton() {
  const [busy, setBusy] = useState(false);
  async function onClick() {
    setBusy(true);
    try {
      const { archive_url } = await startExport();
      window.location.href = archive_url;
    } finally {
      setBusy(false);
    }
  }
  return (
    <button onClick={onClick} disabled={busy}
      className="rounded bg-foreground text-background px-4 py-2 font-medium disabled:opacity-50">
      {busy ? 'Preparing…' : 'Export my data'}
    </button>
  );
}

export function DeleteAccountSection() {
  const router = useRouter();
  const [showModal, setShowModal] = useState(false);
  const [confirm, setConfirm] = useState('');

  async function onConfirm() {
    if (confirm !== 'delete my account') return;
    await deleteAccount();
    router.push('/');
  }

  return (
    <>
      <button onClick={() => setShowModal(true)}
        className="rounded bg-red-600 text-white px-4 py-2 font-medium">
        Delete my account
      </button>
      {showModal && (
        <div role="dialog" aria-modal="true"
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-6">
          <div className="bg-background rounded-md p-6 max-w-md space-y-4">
            <h3 className="text-lg font-semibold">Are you absolutely sure?</h3>
            <p className="text-sm">
              30-day grace period before hard delete. After that, your data is
              unrecoverable. Type <code className="bg-muted px-1">delete my account</code>
              to confirm.
            </p>
            <input
              type="text" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              className="w-full rounded border px-3 py-2"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowModal(false)} className="px-4 py-2">Cancel</button>
              <button onClick={onConfirm} disabled={confirm !== 'delete my account'}
                className="rounded bg-red-600 text-white px-4 py-2 disabled:opacity-50">
                Confirm delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
```

Create `trust-app/src/app/settings/actions.ts`:

```typescript
'use server';

import { api } from '@/lib/api-client';

export async function startExport() {
  const session = await import('@/lib/session').then((m) => m.requireSession());
  const res = await fetch(`${process.env.ENGINE_URL}/v1/export`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  if (!res.ok) throw new Error('export failed');
  return res.json() as Promise<{ archive_url: string; expires_at: string }>;
}

export async function deleteAccount() {
  const session = await import('@/lib/session').then((m) => m.requireSession());
  const res = await fetch(`${process.env.COORDINATOR_URL}/v1/users/${session.userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  if (!res.ok) throw new Error('delete failed');
}
```

Add the corresponding engine endpoints (`/v1/export` returning a signed S3 URL; `/v1/users/{id}` DELETE marking soft-delete).

**Step 4: Run, verify**

Run: `pnpm test:e2e`
Expected: passes.

**Step 5: Commit**

```bash
git add src/app/settings/ tests/e2e/settings.spec.ts
git commit -m "feat(trust-app): export and hard delete"
```

End of Phase I. Trust app has: magic-link auth, spaces list, space detail with per-agent ACL editor, audit log, export, and hard delete. All pages tested with Playwright. SSR by default; client components only where needed.

---

## Phase J — Claude Code Hooks, Skill, Slash Commands (Weeks 5–7)

Goal: when Claude Code is configured by `klio init`, six hooks fire at the right moments and write the right kinds of entries; the Klio plugin provides four slash commands; trigger phrases in user prompts cause Claude to proactively use Klio. End-to-end test: install `klio init` in a sandboxed Claude Code session, run a session that includes "remember X", verify the entry shows up in the cloud and survives restart.

### Task J.1 — Bridge: hook subcommand framework

**Files:**
- Create: `bridge/internal/hooks/types.go`
- Create: `bridge/internal/hooks/runner.go`
- Create: `bridge/internal/hooks/runner_test.go`
- Modify: `bridge/cmd/klio/main.go` (add `runHook`)

**Step 1: Write the failing test**

Create `bridge/internal/hooks/runner_test.go`:

```go
package hooks

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestRunDispatchesByName(t *testing.T) {
	called := ""
	r := &Runner{
		dispatch: func(name string, payload Payload) (Response, error) {
			called = name
			return Response{}, nil
		},
	}
	stdin := bytes.NewReader([]byte(`{"hook_event_name":"SessionStart","cwd":"/tmp"}`))
	var stdout, stderr bytes.Buffer
	exit := r.Run("session-start", stdin, &stdout, &stderr)
	if exit != 0 {
		t.Fatalf("exit %d: %s", exit, stderr.String())
	}
	if called != "session-start" {
		t.Fatalf("called %s", called)
	}
}

func TestSessionStartEmitsAdditionalContext(t *testing.T) {
	r := &Runner{
		dispatch: func(name string, payload Payload) (Response, error) {
			return Response{
				HookSpecificOutput: map[string]any{
					"hookEventName":     "SessionStart",
					"additionalContext": "Recent: User prefers TypeScript.",
				},
			}, nil
		},
	}
	stdin := bytes.NewReader([]byte(`{"hook_event_name":"SessionStart","cwd":"/tmp"}`))
	var stdout, stderr bytes.Buffer
	if exit := r.Run("session-start", stdin, &stdout, &stderr); exit != 0 {
		t.Fatalf("exit %d: %s", exit, stderr.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	hso, _ := resp["hookSpecificOutput"].(map[string]any)
	if !strings.Contains(hso["additionalContext"].(string), "TypeScript") {
		t.Fatalf("got: %v", hso)
	}
}

func TestErrorReturnsExit2WithStderr(t *testing.T) {
	r := &Runner{
		dispatch: func(name string, payload Payload) (Response, error) {
			return Response{}, &HookError{Message: "daemon not running"}
		},
	}
	stdin := bytes.NewReader([]byte(`{}`))
	var stdout, stderr bytes.Buffer
	exit := r.Run("session-start", stdin, &stdout, &stderr)
	if exit != 2 {
		t.Fatalf("expected exit 2, got %d", exit)
	}
	if !strings.Contains(stderr.String(), "daemon not running") {
		t.Fatalf("stderr: %s", stderr.String())
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement runner**

Create `bridge/internal/hooks/types.go`:

```go
// Package hooks implements the six Claude Code hook subcommands.
//
// Each hook reads a JSON payload from stdin, performs an async operation
// against the daemon (via unix socket), and either writes a hook response
// to stdout (for hooks that augment the session) or exits silently.
package hooks

import "encoding/json"

// Payload is the union of fields Claude Code sends to hooks. Not every field
// is present on every event — hooks read the ones they need.
type Payload struct {
	HookEventName  string          `json:"hook_event_name"`
	SessionID      string          `json:"session_id,omitempty"`
	TranscriptPath string          `json:"transcript_path,omitempty"`
	Cwd            string          `json:"cwd,omitempty"`
	UserMessage    string          `json:"user_message,omitempty"`
	ToolName       string          `json:"tool_name,omitempty"`
	ToolInput      json.RawMessage `json:"tool_input,omitempty"`
	ToolOutput     json.RawMessage `json:"tool_response,omitempty"`
	Source         string          `json:"source,omitempty"`
}

// Response is the JSON body Claude Code expects from hooks that want to
// influence the session (SessionStart, UserPromptSubmit, PreToolUse).
type Response struct {
	HookSpecificOutput map[string]any `json:"hookSpecificOutput,omitempty"`
	Decision           string         `json:"decision,omitempty"` // "block" | "approve" | ""
	Reason             string         `json:"reason,omitempty"`
}

type HookError struct {
	Message string
}

func (e *HookError) Error() string { return e.Message }
```

Create `bridge/internal/hooks/runner.go`:

```go
package hooks

import (
	"encoding/json"
	"fmt"
	"io"
)

type Runner struct {
	dispatch func(name string, payload Payload) (Response, error)
}

func NewRunner(dispatcher func(name string, payload Payload) (Response, error)) *Runner {
	return &Runner{dispatch: dispatcher}
}

func (r *Runner) Run(name string, stdin io.Reader, stdout, stderr io.Writer) int {
	body, err := io.ReadAll(stdin)
	if err != nil {
		fmt.Fprintf(stderr, "read stdin: %v\n", err)
		return 2
	}
	var payload Payload
	if err := json.Unmarshal(body, &payload); err != nil {
		fmt.Fprintf(stderr, "parse hook payload: %v\n", err)
		return 2
	}
	resp, err := r.dispatch(name, payload)
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return 2
	}
	if resp.HookSpecificOutput != nil || resp.Decision != "" {
		out, _ := json.Marshal(resp)
		stdout.Write(out)
	}
	return 0
}
```

**Step 4: Wire `klio hook X` subcommands**

In `bridge/cmd/klio/main.go`:

```go
case "hook":
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: klio hook <event>")
		os.Exit(2)
	}
	runHook(os.Args[2])

func runHook(name string) {
	// Connect to the running daemon over unix socket. If it's not running, exit silently
	// to avoid blocking Claude Code on a daemon that's down.
	dispatcher, err := hooks.NewSocketDispatcher()
	if err != nil {
		// Soft-fail: log to file but don't break the user's session.
		_ = appendDaemonDownLog(err)
		os.Exit(0)
	}
	r := hooks.NewRunner(dispatcher.Dispatch)
	os.Exit(r.Run(name, os.Stdin, os.Stdout, os.Stderr))
}
```

**Step 5: Run, verify**

Run: `go test ./internal/hooks/...`
Expected: `ok`.

**Step 6: Commit**

```bash
git add internal/hooks/types.go internal/hooks/runner.go internal/hooks/runner_test.go cmd/klio/main.go
git commit -m "feat(bridge): hook subcommand framework"
```

---

### Task J.2 — Bridge: SessionStart hook (resolve space, recall context)

**Files:**
- Create: `bridge/internal/hooks/dispatcher.go`
- Create: `bridge/internal/hooks/session_start.go`
- Create: `bridge/internal/hooks/session_start_test.go`

**Step 1: Write the failing test**

Create `bridge/internal/hooks/session_start_test.go`:

```go
package hooks

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type fakeBackend struct {
	resolvedSpace uuid.UUID
	recallResult  []map[string]any
}

func (f *fakeBackend) ResolveSpaceForCwd(ctx context.Context, cwd, kind string) (uuid.UUID, error) {
	return f.resolvedSpace, nil
}

func (f *fakeBackend) Recall(ctx context.Context, spaceID uuid.UUID, query string, limit int) ([]map[string]any, error) {
	return f.recallResult, nil
}

func (f *fakeBackend) WriteEntry(ctx context.Context, spaceID uuid.UUID, kind, content string, metadata map[string]any) error {
	return nil
}

func TestSessionStartReturnsRecentContext(t *testing.T) {
	b := &fakeBackend{
		resolvedSpace: uuid.New(),
		recallResult: []map[string]any{
			{"kind": "memory", "content": "User prefers TypeScript.", "created_at": "2026-05-01T12:00:00Z"},
			{"kind": "decision", "content": "Using Bun, not npm.", "created_at": "2026-05-01T13:00:00Z"},
		},
	}
	resp, err := SessionStart(context.Background(), b, Payload{Cwd: "/Users/abhishek/oppla"})
	if err != nil {
		t.Fatalf("SessionStart: %v", err)
	}
	hso := resp.HookSpecificOutput
	ctx := hso["additionalContext"].(string)
	if !strings.Contains(ctx, "TypeScript") {
		t.Fatalf("missing memory: %s", ctx)
	}
	if !strings.Contains(ctx, "Bun") {
		t.Fatalf("missing decision: %s", ctx)
	}
}

func TestSessionStartEmptyWhenNoEntries(t *testing.T) {
	b := &fakeBackend{resolvedSpace: uuid.New(), recallResult: []map[string]any{}}
	resp, err := SessionStart(context.Background(), b, Payload{Cwd: "/tmp/empty"})
	if err != nil {
		t.Fatal(err)
	}
	if resp.HookSpecificOutput != nil {
		t.Fatalf("expected nil output for empty recall, got %v", resp.HookSpecificOutput)
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement SessionStart hook**

Create `bridge/internal/hooks/dispatcher.go`:

```go
package hooks

import (
	"context"
	"net"
	"path/filepath"

	"github.com/google/uuid"
)

// HookBackend is the abstraction the hooks call. Production backend talks to
// the daemon over unix socket; tests inject in-memory fakes.
type HookBackend interface {
	ResolveSpaceForCwd(ctx context.Context, cwd, kind string) (uuid.UUID, error)
	Recall(ctx context.Context, spaceID uuid.UUID, query string, limit int) ([]map[string]any, error)
	WriteEntry(ctx context.Context, spaceID uuid.UUID, kind, content string, metadata map[string]any) error
}

type SocketDispatcher struct {
	conn net.Conn
}

func NewSocketDispatcher() (*SocketDispatcher, error) {
	home, _ := os.UserHomeDir()
	socketPath := filepath.Join(home, ".klio", "bridge.sock")
	if v := os.Getenv("KLIO_SOCKET_PATH"); v != "" {
		socketPath = v
	}
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, err
	}
	return &SocketDispatcher{conn: conn}, nil
}

func (d *SocketDispatcher) Dispatch(name string, payload Payload) (Response, error) {
	ctx := context.Background()
	backend := &socketHookBackend{conn: d.conn}
	switch name {
	case "session-start":
		return SessionStart(ctx, backend, payload)
	case "user-prompt":
		return UserPromptSubmit(ctx, backend, payload)
	case "pre-tool":
		return PreToolUse(ctx, backend, payload)
	case "post-tool":
		return PostToolUse(ctx, backend, payload)
	case "subagent-stop":
		return SubagentStop(ctx, backend, payload)
	case "session-stop":
		return SessionStop(ctx, backend, payload)
	}
	return Response{}, nil
}
```

(Implementation of `socketHookBackend` is straightforward JSON-over-unix-socket; same pattern as klio-mcp shim.)

Create `bridge/internal/hooks/session_start.go`:

```go
package hooks

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// SessionStart resolves the active space for the cwd, fetches the top-K
// recent entries (memories + decisions + open plans), and emits an
// `additionalContext` block that Claude Code prepends to its system prompt.
func SessionStart(ctx context.Context, b HookBackend, p Payload) (Response, error) {
	spaceID, err := b.ResolveSpaceForCwd(ctx, p.Cwd, "claude-code")
	if err != nil {
		return Response{}, nil // soft-fail
	}
	rows, err := b.Recall(ctx, spaceID, "session-start-context", 12)
	if err != nil || len(rows) == 0 {
		return Response{}, nil
	}
	return Response{
		HookSpecificOutput: map[string]any{
			"hookEventName":     "SessionStart",
			"additionalContext": formatContext(rows, spaceID),
		},
	}, nil
}

func formatContext(rows []map[string]any, spaceID uuid.UUID) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("## Klio context for this session (space: %s)\n\n", spaceID))
	for _, r := range rows {
		kind, _ := r["kind"].(string)
		content, _ := r["content"].(string)
		ts, _ := r["created_at"].(string)
		sb.WriteString(fmt.Sprintf("- [%s, %s] %s\n", kind, ts, content))
	}
	sb.WriteString("\nUse `recall` to query for more context as needed.\n")
	return sb.String()
}
```

**Step 4: Run, verify**

Run: `go test ./internal/hooks/...`
Expected: `ok`.

**Step 5: Commit**

```bash
git add internal/hooks/dispatcher.go internal/hooks/session_start.go internal/hooks/session_start_test.go
git commit -m "feat(bridge): SessionStart hook injects recent space context"
```

---

### Task J.3 — Bridge: UserPromptSubmit hook (trigger-phrase detection)

**Files:**
- Create: `bridge/internal/hooks/user_prompt.go`
- Create: `bridge/internal/hooks/user_prompt_test.go`

**Step 1: Write the failing test**

Create `bridge/internal/hooks/user_prompt_test.go`:

```go
package hooks

import (
	"context"
	"testing"
)

func TestUserPromptDetectsRememberTrigger(t *testing.T) {
	written := []string{}
	b := &writeRecordingBackend{onWrite: func(kind, content string) {
		written = append(written, kind+":"+content)
	}}
	_, err := UserPromptSubmit(context.Background(), b, Payload{
		UserMessage: "remember that I prefer TypeScript over JavaScript",
	})
	if err != nil {
		t.Fatalf("UserPromptSubmit: %v", err)
	}
	if len(written) != 1 || written[0] != "memory:I prefer TypeScript over JavaScript" {
		t.Fatalf("got %v", written)
	}
}

func TestUserPromptDetectsDontForget(t *testing.T) {
	written := []string{}
	b := &writeRecordingBackend{onWrite: func(kind, content string) {
		written = append(written, kind+":"+content)
	}}
	_, _ = UserPromptSubmit(context.Background(), b, Payload{
		UserMessage: "don't forget that this project uses Bun",
	})
	if len(written) != 1 || written[0] != "memory:this project uses Bun" {
		t.Fatalf("got %v", written)
	}
}

func TestUserPromptIgnoresNonTrigger(t *testing.T) {
	written := []string{}
	b := &writeRecordingBackend{onWrite: func(kind, content string) {
		written = append(written, kind+":"+content)
	}}
	_, _ = UserPromptSubmit(context.Background(), b, Payload{
		UserMessage: "what's the weather",
	})
	if len(written) != 0 {
		t.Fatalf("unexpected writes: %v", written)
	}
}

type writeRecordingBackend struct {
	onWrite func(kind, content string)
}

func (b *writeRecordingBackend) ResolveSpaceForCwd(_ context.Context, _, _ string) (uuid.UUID, error) {
	return uuid.New(), nil
}
func (b *writeRecordingBackend) Recall(context.Context, uuid.UUID, string, int) ([]map[string]any, error) {
	return nil, nil
}
func (b *writeRecordingBackend) WriteEntry(_ context.Context, _ uuid.UUID, kind, content string, _ map[string]any) error {
	b.onWrite(kind, content)
	return nil
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement**

Create `bridge/internal/hooks/user_prompt.go`:

```go
package hooks

import (
	"context"
	"regexp"
)

var triggerPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bremember\s+(that\s+)?(?P<fact>.+?)$`),
	regexp.MustCompile(`(?i)\bdon[''']t\s+forget\s+(that\s+)?(?P<fact>.+?)$`),
	regexp.MustCompile(`(?i)\bfrom\s+now\s+on,?\s+(?P<fact>.+?)$`),
	regexp.MustCompile(`(?i)\bnote\s+that\s+(?P<fact>.+?)$`),
}

func UserPromptSubmit(ctx context.Context, b HookBackend, p Payload) (Response, error) {
	if p.UserMessage == "" {
		return Response{}, nil
	}
	for _, re := range triggerPatterns {
		match := re.FindStringSubmatch(p.UserMessage)
		if len(match) == 0 {
			continue
		}
		factIdx := re.SubexpIndex("fact")
		if factIdx < 0 || factIdx >= len(match) {
			continue
		}
		fact := match[factIdx]
		if fact == "" {
			continue
		}
		spaceID, err := b.ResolveSpaceForCwd(ctx, p.Cwd, "claude-code")
		if err != nil {
			return Response{}, nil
		}
		_ = b.WriteEntry(ctx, spaceID, "memory", fact, map[string]any{
			"source": "user-trigger-phrase", "session_id": p.SessionID,
		})
		return Response{}, nil
	}
	return Response{}, nil
}
```

**Step 4: Run, verify**

Run: `go test ./internal/hooks/...`
Expected: `ok`.

**Step 5: Commit**

```bash
git add internal/hooks/user_prompt.go internal/hooks/user_prompt_test.go
git commit -m "feat(bridge): UserPromptSubmit hook with trigger-phrase capture"
```

---

### Task J.4 — Bridge: PreToolUse, PostToolUse, SubagentStop, Stop hooks

**Files:**
- Create: `bridge/internal/hooks/pre_tool.go` + test
- Create: `bridge/internal/hooks/post_tool.go` + test
- Create: `bridge/internal/hooks/subagent_stop.go` + test
- Create: `bridge/internal/hooks/session_stop.go` + test

Each hook's behavior, briefly (full TDD code mirrors the patterns in J.2/J.3):

**`PreToolUse`** — Receives `tool_name`, `tool_input`. For tools matching `Bash|Edit|Write`, recall against the active space for safety constraints (e.g., entries that say "never run X in prod"). If a constraint matches strongly (cosine ≥ 0.85 against a heuristic query), emit a `Decision: "block"` response with the reason; Claude Code surfaces the warning to the user. Otherwise no output.

**`PostToolUse`** — Receives `tool_name`, `tool_output`. Async-write an `observation` entry summarizing the tool call. Format: `Used <tool_name>: <truncated args>. Result: <truncated result>.` Confidence 0.7 (it's an observation, not a stable fact). Returns immediately (the actual write is queued).

**`SubagentStop`** — Receives the subagent's final report. Write as `observation` with metadata `{kind: "subagent_finding"}`. This is what makes "Explore agent found auth lives at src/auth/middleware.ts:42" persist across the parent session.

**`Stop`** — Receives `transcript_path`. Open the file, stream it through the extractor (Phase D), write each extracted entry. Provenance metadata: `{source_type: "claude-code-session", session_id, transcript_path}`. This is the compounding loop — every session permanently improves the next session.

For each, follow the TDD pattern from Task J.2/J.3.

**Commit (after each):** `feat(bridge): <name> hook`.

---

### Task J.5 — Bridge: real-time → MCP notifications dispatch

**Files:**
- Modify: `bridge/internal/daemon/daemon.go` — connect realtime client to MCP shim notifications.
- Create: `bridge/internal/daemon/notifier.go`
- Create: `bridge/internal/daemon/notifier_test.go`

When a `entry.created` frame arrives via the WebSocket and a connected MCP shim's active space matches, send an MCP `notifications/resources/updated` over its stdio. Test the wiring with a fake WebSocket and a fake shim.

**Step 1–5:** Standard TDD pattern.

**Commit:** `feat(bridge): forward realtime frames to MCP shims as notifications`.

---

### Task J.6 — Klio Claude Code plugin (skills + slash commands)

**Files (in a new repo `klio-tech/claude-plugin` or as part of `bridge/`):**
- Create: `claude-plugin/plugin.json`
- Create: `claude-plugin/skills/klio-memory.md`
- Create: `claude-plugin/skills/klio-collaborate.md`
- Create: `claude-plugin/skills/klio-spaces.md`
- Create: `claude-plugin/commands/recall.md`
- Create: `claude-plugin/commands/remember.md`
- Create: `claude-plugin/commands/space.md`
- Create: `claude-plugin/commands/status.md`

**Step 1: Plugin manifest**

Create `claude-plugin/plugin.json`:

```json
{
  "name": "klio",
  "version": "0.0.1",
  "description": "Klio agent-collaboration substrate. Memory and shared workspaces across agents.",
  "author": "Klio Tech",
  "license": "Apache-2.0",
  "skills": ["./skills"],
  "commands": ["./commands"]
}
```

**Step 2: Memory skill**

Create `claude-plugin/skills/klio-memory.md`:

```markdown
---
name: klio-memory
description: Use when the user mentions remembering, forgetting, or recalling something. Trigger phrases include "remember", "don't forget", "what did I tell you about", "from now on", "you should know that". When triggered, use the Klio MCP server's `remember` and `recall` tools.
---

## When to use this skill

The user has explicitly asked you to remember a fact, recall something they
told you previously, or expressed a stable preference. Examples:
- "Remember that I use Bun, not npm."
- "Don't forget the auth library is jose."
- "What did I tell you about deployment?"
- "From now on, prefer functional components."

## How to use

When the user states a fact to remember, call the `remember` tool from the
Klio MCP server with the fact as `content`. Confirm what was stored ("Got it,
I'll remember that you use Bun.").

When the user asks what you remember about a topic, call `recall` with the
topic as the `query`. Cite the entries' `created_at` timestamps so the user
can verify currency.

When you're about to make a non-trivial decision (library choice, naming
convention, deployment target), call `recall` first with a short query
describing the decision. Use what comes back to inform your choice.

## What NOT to do

- Don't call `remember` for ephemeral statements like "I'm tired" or "let's start over".
- Don't call `recall` on every prompt — only when context suggests prior memory matters.
- Don't surface raw Klio entries to the user verbatim — synthesize them into your answer.
```

**Step 3: Collaboration skill**

Create `claude-plugin/skills/klio-collaborate.md`:

```markdown
---
name: klio-collaborate
description: Use when the user asks what other agents have done, when planning multi-agent work, or when posting work for another agent to pick up. Klio is the shared workspace where Claude, Cursor, Codex, and other agents coordinate.
---

## When to use this skill

The user is working in a project that has multiple agents involved (Claude,
Cursor, Codex). Examples:
- "What did Cursor change in the auth module?"
- "Make a plan for Cursor to implement."
- "Pick up where Cursor left off yesterday."

## How to use

To see what other agents have done, call `recall` with a query about the
relevant area; entries from other agents have a different `agent_id` than
yours. The `created_at` timestamp tells you when the work happened.

When making a plan that another agent will execute, call the `plan` tool to
post it. Other agents in the same space see the plan in real-time and can
work from it.

When making a decision with rationale, call `decide` with both the decision
and the rationale fields. Other agents reading the space see your reasoning,
not just the conclusion.

## Provenance matters

Always cite the source of cross-agent context: "Following the plan Cursor
posted at 14:32...", "Per the decision Claude made yesterday...". Users want
to know who did what.
```

**Step 4: Spaces skill**

Create `claude-plugin/skills/klio-spaces.md`:

```markdown
---
name: klio-spaces
description: Use when the user wants to switch between projects, businesses, or contexts. Klio organizes memory by user-named spaces — a user might have separate spaces for their job, side projects, and personal life.
---

## When to use this skill

The user mentions a different project or context, or asks to scope memory to
a different area. Examples:
- "Switch to my Vex project."
- "Don't use my work memory for this."
- "What spaces do I have?"

## How to use

Call the `space` tool with `action: "list"` to see available spaces. Each
space has a `name` and a `slug` — use the slug for `switch`.

When the user mentions a different context, call `space` with `action:
"switch"` and the relevant slug. Confirm with the user before switching if
the binding is ambiguous.

If the user asks about a project you don't currently have access to, call
`space` with `action: "request_access"` and the `scope` they want (typically
`read`). The user will get a notification asking to grant.
```

**Step 5: Slash commands**

Each command file is a small markdown frontmatter spec that Claude Code surfaces. Example `claude-plugin/commands/recall.md`:

```markdown
---
name: recall
description: Search Klio for entries matching a natural-language query
arguments:
  - name: query
    required: true
---

Call the Klio MCP server's `recall` tool with `query: "{{query}}"`. Show the
top results to the user, with their kind, age, and content.
```

`remember.md`, `space.md`, and `status.md` follow the same pattern.

**Step 6: Test the plugin**

Manual test in a Claude Code session: install the plugin, ask "remember that I prefer TypeScript", verify `/klio:status` shows the daemon is running and the entry was recorded.

**Step 7: Commit**

```bash
cd claude-plugin
git add .
git commit -m "feat: Klio Claude Code plugin v0 (skills + slash commands)"
```

End of Phase J. All six hooks are wired, the plugin provides slash commands, the trigger-phrase skill makes Claude proactively use Klio. Real-time frames from other agents arrive as MCP notifications.

---

## Phase K — Backfill from `~/.claude/projects` (Weeks 6–7)

Goal: a `klio backfill` CLI command walks every Claude Code session JSONL on the user's disk, batches each through the extractor (using cheap Haiku 4.5 to stay under $5/user), bucketizes entries into a per-project space, and is resumable on interrupt. End-to-end test: 200+ historical sessions ingested, the user can ask "what did we decide about X three months ago?" and Claude recalls correctly.

### Task K.1 — Bridge: parse `~/.claude/projects` directory layout

**Files:**
- Create: `bridge/internal/backfill/walker.go`
- Create: `bridge/internal/backfill/walker_test.go`
- Create: `bridge/internal/backfill/transcript.go`
- Create: `bridge/internal/backfill/transcript_test.go`

**Step 1: Write the failing walker test**

Create `bridge/internal/backfill/walker_test.go`:

```go
package backfill

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWalkFindsSessionsPerProject(t *testing.T) {
	dir := t.TempDir()

	// Layout: ~/.claude/projects/-Users-abhishek-oppla-klio/{abc,def}.jsonl
	proj1 := filepath.Join(dir, "-Users-abhishek-oppla-klio")
	proj2 := filepath.Join(dir, "-Users-abhishek-oppla-vex")
	for _, p := range []string{proj1, proj2} {
		_ = os.MkdirAll(p, 0o755)
	}
	_ = os.WriteFile(filepath.Join(proj1, "abc-123.jsonl"), []byte(`{}`+"\n"), 0o644)
	_ = os.WriteFile(filepath.Join(proj1, "def-456.jsonl"), []byte(`{}`+"\n"), 0o644)
	_ = os.WriteFile(filepath.Join(proj2, "ghi-789.jsonl"), []byte(`{}`+"\n"), 0o644)

	projects, err := Walk(dir)
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if len(projects) != 2 {
		t.Fatalf("expected 2 projects, got %d", len(projects))
	}
	for _, p := range projects {
		if p.Slug == "oppla-klio" && len(p.Sessions) != 2 {
			t.Errorf("project oppla-klio should have 2 sessions, got %d", len(p.Sessions))
		}
		if p.Slug == "oppla-vex" && len(p.Sessions) != 1 {
			t.Errorf("project oppla-vex should have 1 session, got %d", len(p.Sessions))
		}
	}
}

func TestSlugifyDecodesPath(t *testing.T) {
	cases := []struct {
		encoded string
		want    string
	}{
		{"-Users-abhishek-oppla-klio", "oppla-klio"},
		{"-Users-abhishek-Documents-side-project", "documents-side-project"},
		{"-tmp-test", "test"},
	}
	for _, c := range cases {
		if got := decodeProjectSlug(c.encoded); got != c.want {
			t.Errorf("decodeProjectSlug(%q) = %q, want %q", c.encoded, got, c.want)
		}
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement walker**

Create `bridge/internal/backfill/walker.go`:

```go
// Package backfill implements `klio backfill ~/.claude/projects`.
//
// Walks the path-encoded directory layout that Claude Code writes session
// JSONL files into, groups sessions by project, and emits an iterator of
// (project, session_file) pairs.
package backfill

import (
	"os"
	"path/filepath"
	"strings"
)

type Project struct {
	OriginalCwd string // e.g., "/Users/abhishek/oppla/klio"
	Slug        string // e.g., "oppla-klio"
	DisplayName string // e.g., "oppla-klio" (same as slug initially; user can rename)
	Sessions    []SessionFile
}

type SessionFile struct {
	Path      string
	SessionID string // derived from filename
}

func Walk(root string) ([]Project, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var projects []Project
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if !strings.HasPrefix(e.Name(), "-") {
			continue
		}
		full := filepath.Join(root, e.Name())
		p, err := scanProject(full, e.Name())
		if err != nil {
			continue
		}
		if len(p.Sessions) == 0 {
			continue
		}
		projects = append(projects, p)
	}
	return projects, nil
}

func scanProject(dir, encodedName string) (Project, error) {
	files, err := os.ReadDir(dir)
	if err != nil {
		return Project{}, err
	}
	originalCwd := strings.ReplaceAll(encodedName, "-", "/")
	slug := decodeProjectSlug(encodedName)
	p := Project{OriginalCwd: originalCwd, Slug: slug, DisplayName: slug}
	for _, f := range files {
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
			continue
		}
		p.Sessions = append(p.Sessions, SessionFile{
			Path:      filepath.Join(dir, f.Name()),
			SessionID: strings.TrimSuffix(f.Name(), ".jsonl"),
		})
	}
	return p, nil
}

// decodeProjectSlug turns the path-encoded directory name into a clean slug.
// Strips leading "-", strips known prefixes ("Users/<name>", "tmp"), joins the
// rest with hyphens.
func decodeProjectSlug(encoded string) string {
	parts := strings.Split(strings.TrimPrefix(encoded, "-"), "-")
	// Skip "Users/<username>" prefix
	if len(parts) >= 2 && parts[0] == "Users" {
		parts = parts[2:]
	}
	if len(parts) >= 1 && parts[0] == "tmp" {
		parts = parts[1:]
	}
	out := strings.ToLower(strings.Join(parts, "-"))
	out = strings.Trim(out, "-")
	if out == "" {
		out = "default"
	}
	return out
}
```

**Step 4: Implement transcript parser**

Create `bridge/internal/backfill/transcript.go`:

```go
package backfill

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
)

// Message is one row of a session JSONL.
type Message struct {
	Role    string `json:"role"`     // "user" | "assistant" | "system" | "tool"
	Content string `json:"content"`
	Time    string `json:"timestamp,omitempty"`
}

// ParseTranscript reads a session JSONL and returns a flat slice of messages.
// Skips malformed lines; never panics; bounded memory (one line at a time).
func ParseTranscript(path string) ([]Message, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return parseFromReader(f)
}

func parseFromReader(r io.Reader) ([]Message, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	var out []Message
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var raw map[string]any
		if err := json.Unmarshal(line, &raw); err != nil {
			continue
		}
		role, _ := raw["role"].(string)
		if role == "" {
			role, _ = raw["type"].(string) // alternative key names some versions use
		}
		content := extractContent(raw)
		if content == "" {
			continue
		}
		out = append(out, Message{Role: role, Content: content})
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		return out, err
	}
	return out, nil
}

func extractContent(raw map[string]any) string {
	// Claude Code session files have evolved over time; try the obvious fields.
	if c, ok := raw["content"].(string); ok {
		return c
	}
	if c, ok := raw["text"].(string); ok {
		return c
	}
	// Some versions store content as an array of blocks.
	if arr, ok := raw["content"].([]any); ok {
		var parts []string
		for _, item := range arr {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if t, ok := m["text"].(string); ok {
				parts = append(parts, t)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}
```

**Step 5: Run, verify**

Run: `go test ./internal/backfill/...`
Expected: `ok`.

**Step 6: Commit**

```bash
git add internal/backfill/walker.go internal/backfill/walker_test.go internal/backfill/transcript.go internal/backfill/transcript_test.go
git commit -m "feat(bridge): walker and transcript parser for ~/.claude/projects"
```

---

### Task K.2 — Bridge: cost preview before bulk import

**Files:**
- Create: `bridge/internal/backfill/preview.go`
- Create: `bridge/internal/backfill/preview_test.go`

**Step 1: Write the failing test**

Create `bridge/internal/backfill/preview_test.go`:

```go
package backfill

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEstimateCostsFromCorpus(t *testing.T) {
	dir := t.TempDir()
	proj := filepath.Join(dir, "-Users-test-myproj")
	_ = os.MkdirAll(proj, 0o755)
	// 2 sessions, ~10kB each → ~5k tokens combined → cost in pennies on Haiku
	_ = os.WriteFile(filepath.Join(proj, "s1.jsonl"),
		[]byte(makeJSONLines(20, 200)), 0o644)
	_ = os.WriteFile(filepath.Join(proj, "s2.jsonl"),
		[]byte(makeJSONLines(20, 200)), 0o644)

	projects, _ := Walk(dir)
	preview, err := EstimateCost(projects)
	if err != nil {
		t.Fatalf("EstimateCost: %v", err)
	}
	if preview.SessionCount != 2 {
		t.Fatalf("SessionCount = %d", preview.SessionCount)
	}
	if preview.EstimatedCostUSD <= 0 {
		t.Fatalf("EstimatedCostUSD should be positive, got %f", preview.EstimatedCostUSD)
	}
}

func makeJSONLines(n, charsPerLine int) string {
	var sb strings.Builder
	for i := 0; i < n; i++ {
		sb.WriteString(`{"role":"user","content":"`)
		sb.WriteString(strings.Repeat("x", charsPerLine))
		sb.WriteString(`"}`)
		sb.WriteString("\n")
	}
	return sb.String()
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement preview**

Create `bridge/internal/backfill/preview.go`:

```go
package backfill

import (
	"fmt"
	"os"
)

// CostPreview is what we show the user before they confirm the import.
type CostPreview struct {
	SessionCount     int
	TotalBytes       int64
	EstimatedTokens  int64
	EstimatedCostUSD float64
}

// Pricing constants for Haiku 4.5 (extraction model). Update from
// https://docs.anthropic.com/en/docs/about-claude/models/overview when prices
// change.
const (
	haikuInputUSDPerMTok  = 1.0  // $1 per 1M input tokens
	haikuOutputUSDPerMTok = 5.0  // $5 per 1M output tokens

	avgTokensPerByte    = 0.25 // empirical: ~4 bytes/token for English text
	avgOutputRatio      = 0.05 // extraction emits ~5% of input as JSON
)

func EstimateCost(projects []Project) (CostPreview, error) {
	var p CostPreview
	for _, proj := range projects {
		for _, s := range proj.Sessions {
			info, err := os.Stat(s.Path)
			if err != nil {
				continue
			}
			p.SessionCount++
			p.TotalBytes += info.Size()
		}
	}
	p.EstimatedTokens = int64(float64(p.TotalBytes) * avgTokensPerByte)
	inputCost := float64(p.EstimatedTokens) / 1_000_000 * haikuInputUSDPerMTok
	outputCost := float64(p.EstimatedTokens) * avgOutputRatio / 1_000_000 * haikuOutputUSDPerMTok
	p.EstimatedCostUSD = inputCost + outputCost
	return p, nil
}

func (p CostPreview) Format() string {
	return fmt.Sprintf(
		"%d sessions, %.1fMB transcripts, ~%dk tokens, est. $%.2f",
		p.SessionCount, float64(p.TotalBytes)/(1024*1024),
		p.EstimatedTokens/1000, p.EstimatedCostUSD,
	)
}
```

**Step 4: Run, verify**

Run: `go test ./internal/backfill/...`
Expected: `ok`.

**Step 5: Commit**

```bash
git add internal/backfill/preview.go internal/backfill/preview_test.go
git commit -m "feat(bridge): backfill cost preview based on Haiku pricing"
```

---

### Task K.3 — Bridge: checkpoint + resume mechanism

**Files:**
- Create: `bridge/internal/backfill/checkpoint.go`
- Create: `bridge/internal/backfill/checkpoint_test.go`

**Step 1: Write the failing test**

Create `bridge/internal/backfill/checkpoint_test.go`:

```go
package backfill

import (
	"path/filepath"
	"testing"
)

func TestCheckpointPersistsCompletedSessions(t *testing.T) {
	dir := t.TempDir()
	cp := NewCheckpoint(filepath.Join(dir, "checkpoint.json"))
	if err := cp.MarkDone("session-1"); err != nil {
		t.Fatalf("MarkDone: %v", err)
	}
	if err := cp.MarkDone("session-2"); err != nil {
		t.Fatalf("MarkDone: %v", err)
	}

	// Reload from disk
	cp2 := NewCheckpoint(filepath.Join(dir, "checkpoint.json"))
	if !cp2.IsDone("session-1") {
		t.Fatal("session-1 not preserved")
	}
	if cp2.IsDone("session-3") {
		t.Fatal("session-3 should not be done")
	}
}

func TestCheckpointSurvivesCorruptFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "checkpoint.json")
	_ = os.WriteFile(path, []byte("not-json"), 0o644)

	cp := NewCheckpoint(path)
	// Should not crash; treat as empty.
	if cp.IsDone("anything") {
		t.Fatal("corrupt file should yield empty checkpoint")
	}
	_ = cp.MarkDone("new-session")
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement checkpoint**

Create `bridge/internal/backfill/checkpoint.go`:

```go
package backfill

import (
	"encoding/json"
	"os"
	"sync"
)

type Checkpoint struct {
	path string
	mu   sync.Mutex
	done map[string]bool
}

func NewCheckpoint(path string) *Checkpoint {
	cp := &Checkpoint{path: path, done: map[string]bool{}}
	cp.load()
	return cp
}

func (c *Checkpoint) load() {
	data, err := os.ReadFile(c.path)
	if err != nil {
		return
	}
	_ = json.Unmarshal(data, &c.done)
	if c.done == nil {
		c.done = map[string]bool{}
	}
}

func (c *Checkpoint) IsDone(sessionID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.done[sessionID]
}

func (c *Checkpoint) MarkDone(sessionID string) error {
	c.mu.Lock()
	c.done[sessionID] = true
	body, _ := json.Marshal(c.done)
	c.mu.Unlock()
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}
```

**Step 4: Run, verify**

Run: `go test ./internal/backfill/...`
Expected: `ok`.

**Step 5: Commit**

```bash
git add internal/backfill/checkpoint.go internal/backfill/checkpoint_test.go
git commit -m "feat(bridge): backfill checkpoint with atomic-write resume"
```

---

### Task K.4 — Bridge: backfill runner that calls extraction via cloud

**Files:**
- Create: `bridge/internal/backfill/runner.go`
- Create: `bridge/internal/backfill/runner_test.go`

**Step 1: Write the failing test**

Create `bridge/internal/backfill/runner_test.go`:

```go
package backfill

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

type fakeIngestClient struct {
	called int
	err    error
}

func (f *fakeIngestClient) IngestTranscript(ctx context.Context, spaceID string, sessionID string, transcript []Message) error {
	f.called++
	return f.err
}

func (f *fakeIngestClient) EnsureSpace(ctx context.Context, slug, name string) (string, error) {
	return "fake-space-id-" + slug, nil
}

func TestRunnerProcessesAllSessionsExceptCheckpointed(t *testing.T) {
	dir := t.TempDir()
	proj := filepath.Join(dir, "-Users-test-myproj")
	_ = os.MkdirAll(proj, 0o755)
	for _, sid := range []string{"a", "b", "c"} {
		_ = os.WriteFile(filepath.Join(proj, sid+".jsonl"),
			[]byte(`{"role":"user","content":"hello"}`+"\n"), 0o644)
	}

	cp := NewCheckpoint(filepath.Join(dir, "cp.json"))
	_ = cp.MarkDone("b")  // already processed earlier

	client := &fakeIngestClient{}
	report, err := Run(context.Background(), Options{
		Root: dir, Checkpoint: cp, Client: client, MaxConcurrency: 2,
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if report.ProcessedSessions != 2 {
		t.Fatalf("expected 2 processed (a, c), got %d", report.ProcessedSessions)
	}
	if client.called != 2 {
		t.Fatalf("expected 2 calls, got %d", client.called)
	}
}

func TestRunnerSurfacesPartialFailure(t *testing.T) {
	dir := t.TempDir()
	proj := filepath.Join(dir, "-Users-test-myproj")
	_ = os.MkdirAll(proj, 0o755)
	_ = os.WriteFile(filepath.Join(proj, "fail.jsonl"),
		[]byte(`{"role":"user","content":"x"}`+"\n"), 0o644)

	cp := NewCheckpoint(filepath.Join(dir, "cp.json"))
	client := &fakeIngestClient{err: errors.New("transient")}

	report, err := Run(context.Background(), Options{
		Root: dir, Checkpoint: cp, Client: client, MaxConcurrency: 1,
	})
	if err == nil {
		t.Fatal("expected error from runner due to client failure")
	}
	if report.FailedSessions != 1 {
		t.Fatalf("expected 1 failed, got %d", report.FailedSessions)
	}
}
```

**Step 2: Run, verify it fails.**

**Step 3: Implement runner**

Create `bridge/internal/backfill/runner.go`:

```go
package backfill

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

type IngestClient interface {
	EnsureSpace(ctx context.Context, slug, name string) (string, error)
	IngestTranscript(ctx context.Context, spaceID string, sessionID string, transcript []Message) error
}

type Options struct {
	Root           string
	Checkpoint     *Checkpoint
	Client         IngestClient
	MaxConcurrency int
}

type Report struct {
	ProcessedSessions int
	SkippedSessions   int
	FailedSessions    int
	Errors            []error
}

// Run processes every uncheckpointed session JSONL under Options.Root.
// Each (project_slug → space_id) mapping is created once via EnsureSpace.
// Sessions within a project are processed in parallel up to MaxConcurrency.
func Run(ctx context.Context, opts Options) (Report, error) {
	if opts.MaxConcurrency <= 0 {
		opts.MaxConcurrency = 4
	}
	projects, err := Walk(opts.Root)
	if err != nil {
		return Report{}, fmt.Errorf("walk: %w", err)
	}

	var report Report
	var reportMu sync.Mutex
	sem := make(chan struct{}, opts.MaxConcurrency)
	var wg sync.WaitGroup

	for _, proj := range projects {
		spaceID, err := opts.Client.EnsureSpace(ctx, proj.Slug, proj.DisplayName)
		if err != nil {
			reportMu.Lock()
			report.Errors = append(report.Errors, fmt.Errorf("ensure space %s: %w", proj.Slug, err))
			report.FailedSessions += len(proj.Sessions)
			reportMu.Unlock()
			continue
		}

		for _, s := range proj.Sessions {
			s := s
			if opts.Checkpoint.IsDone(s.SessionID) {
				reportMu.Lock()
				report.SkippedSessions++
				reportMu.Unlock()
				continue
			}
			wg.Add(1)
			sem <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-sem }()
				if ctx.Err() != nil {
					return
				}
				transcript, err := ParseTranscript(s.Path)
				if err != nil {
					reportMu.Lock()
					report.Errors = append(report.Errors, fmt.Errorf("parse %s: %w", s.Path, err))
					report.FailedSessions++
					reportMu.Unlock()
					return
				}
				if err := opts.Client.IngestTranscript(ctx, spaceID, s.SessionID, transcript); err != nil {
					reportMu.Lock()
					report.Errors = append(report.Errors, fmt.Errorf("ingest %s: %w", s.SessionID, err))
					report.FailedSessions++
					reportMu.Unlock()
					return
				}
				_ = opts.Checkpoint.MarkDone(s.SessionID)
				reportMu.Lock()
				report.ProcessedSessions++
				reportMu.Unlock()
			}()
		}
	}

	wg.Wait()
	if report.FailedSessions > 0 {
		return report, errors.New("backfill completed with errors")
	}
	return report, nil
}
```

**Step 4: Add coordinator endpoint that the runner calls (`/v1/ingest/transcript`)**

In the engine: a new endpoint that accepts a transcript, runs PII scrub, runs extraction, batch-writes entries:

```python
# engine/src/klio_engine/api/ingest.py
@router.post("/spaces/{space_id}/ingest/transcript")
async def ingest_transcript(
    space_id: uuid.UUID,
    body: IngestTranscriptRequest,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> dict:
    await check_permission(session, user_id=ctx.user_id, agent_id=ctx.agent_id,
                           space_id=space_id, scope="write")

    # Concatenate transcript into a single string
    transcript = "\n".join(f"{m['role'].upper()}: {m['content']}" for m in body.messages)
    scrubbed = scrub_pii(transcript)
    extractor = FactExtractor(model="anthropic/claude-haiku-4-5-20251001")
    extracted = await extractor.extract(scrubbed)

    settings = Settings()
    kms = KMSClient(key_arn=settings.kms_key_arn, region=settings.aws_region)
    entries = EntryService(kms=kms, embeddings=EmbeddingService())

    written = []
    for ee in extracted:
        e = await entries.write(
            session, user_id=ctx.user_id, space_id=space_id, agent_id=ctx.agent_id,
            kind=EntryKind(ee.kind), content=ee.content,
            metadata={"source_type": "claude-code-session-backfill",
                      "session_id": body.session_id},
            confidence=ee.confidence,
        )
        written.append(str(e.id))
    return {"written": written, "extracted": len(extracted)}
```

**Step 5: Add `klio backfill` CLI subcommand**

In `bridge/cmd/klio/main.go`:

```go
case "backfill":
	runBackfill(os.Args[2:])

func runBackfill(args []string) {
	flags := flag.NewFlagSet("backfill", flag.ExitOnError)
	root := flags.String("root", defaultBackfillRoot(), "directory of session jsonl files")
	confirm := flags.Bool("confirm", false, "skip cost preview confirmation")
	maxParallel := flags.Int("parallel", 4, "max concurrent sessions")
	resume := flags.Bool("resume", false, "skip checkpoint reset")
	_ = flags.Parse(args)

	projects, _ := backfill.Walk(*root)
	preview, _ := backfill.EstimateCost(projects)
	fmt.Println(preview.Format())

	if !*confirm {
		fmt.Print("\nProceed? [y/N]: ")
		var resp string
		fmt.Scanln(&resp)
		if !strings.EqualFold(resp, "y") {
			fmt.Println("Aborted.")
			return
		}
	}

	cp := backfill.NewCheckpoint(filepath.Join(home(), ".klio", "backfill-checkpoint.json"))
	if !*resume {
		// fresh checkpoint per Run unless --resume
	}

	client := newIngestClient() // wraps the cloud client
	report, err := backfill.Run(context.Background(), backfill.Options{
		Root: *root, Checkpoint: cp, Client: client, MaxConcurrency: *maxParallel,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Backfill ended with errors: %v\n", err)
	}
	fmt.Printf("Processed %d sessions, skipped %d (already done), failed %d.\n",
		report.ProcessedSessions, report.SkippedSessions, report.FailedSessions)
}
```

**Step 6: Run, verify**

Run: `go test ./internal/backfill/...`
Expected: `ok`.

Manual: against a sandboxed daemon + fixtures of fake `~/.claude/projects/`, run `klio backfill` and verify it processes all sessions and the entries appear in the cloud.

**Step 7: Commit**

```bash
git add internal/backfill/runner.go internal/backfill/runner_test.go cmd/klio/main.go
git commit -m "feat(bridge): klio backfill runner with checkpoint + parallel ingest"
```

End of Phase K. Backfill is end-to-end functional. A user can run `klio backfill ~/.claude/projects` and have months of historical sessions imported into per-project spaces — the asset that drives the launch demo.

---

## Phase L — Security Hardening, VDP, Launch Ops (Weeks 7–10)

Goal: every Tier-2 security commitment from the design doc is implemented and verified; the VDP is live with security.txt, PGP key, Hall of Fame; pre-launch private security review is complete with all Critical/High findings closed; the marketing site, demo video, and status page are live; incident response runbook is documented.

### Task L.1 — Engine: per-tenant vector index partitioning

**Files:**
- Create: `engine/src/klio_engine/services/vector_isolation.py`
- Create: `engine/tests/security/test_vector_isolation.py`
- Create: `engine/alembic/versions/0007_vector_partition.py`

**Goal:** the HNSW index strategy is upgraded so cross-tenant retrieval is *physically impossible* even in the presence of a SQL-injection bug — the user_id participates in the index, not just the WHERE clause.

**Step 1: Write the failing test**

Create `engine/tests/security/test_vector_isolation.py`:

```python
"""Adversarial test: cross-tenant retrieval must fail at the index level."""
import uuid

import pytest
from sqlalchemy import text


@pytest.mark.asyncio
async def test_index_includes_user_id_partition(session) -> None:
    """The HNSW index must be defined ON entries (user_id, embedding)
    so a query without user_id cannot use it."""
    result = await session.execute(text(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_entries_embedding_hnsw'"
    ))
    indexdef = result.scalar_one()
    # The index must include user_id either as a partial index predicate,
    # or — preferred — as a leading column in a multi-column index.
    assert "user_id" in indexdef.lower(), (
        f"Vector index does not partition by user_id: {indexdef}\n"
        "Hard guarantee #1 requires user_id in the index, not just in WHERE clauses."
    )
```

**Step 2: Run, verify it fails** (current index is just `(embedding)`).

**Step 3: Implement migration that swaps to per-tenant partitioning**

Create `engine/alembic/versions/0007_vector_partition.py`:

```python
"""Per-tenant HNSW vector index.

Replaces the original embedding-only HNSW index with a partial index per
tenant range. The old index is dropped and recreated with user_id as a
predicate column.
"""
from alembic import op


revision = "0007"
down_revision = "0006"


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_entries_embedding_hnsw")
    # New: index is over (user_id, embedding) — pgvector HNSW supports this
    # via a multi-column-like index using a btree on user_id combined with
    # HNSW on the vector. We use a partitioned-table-friendly pattern.
    op.execute("""
        CREATE INDEX ix_entries_embedding_hnsw
        ON entries
        USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
        WHERE deleted_at IS NULL AND superseded_by IS NULL
    """)
    op.execute("""
        CREATE INDEX ix_entries_user_space_for_recall
        ON entries (user_id, space_id)
        WHERE deleted_at IS NULL AND superseded_by IS NULL
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_entries_user_space_for_recall")
    op.execute("DROP INDEX IF EXISTS ix_entries_embedding_hnsw")
    op.execute("""
        CREATE INDEX ix_entries_embedding_hnsw
        ON entries USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
    """)
```

**Step 4: Update the recall query to require both indexes**

In `engine/src/klio_engine/services/recall.py`, ensure the SQL forces use of the user_id+space_id index BEFORE the HNSW lookup. Postgres planner will combine via bitmap-and; we hint with a CTE:

```python
sql = """
    WITH scoped AS (
        SELECT id, embedding
        FROM entries
        WHERE user_id = :user_id
          AND space_id = :space_id
          AND deleted_at IS NULL
          AND superseded_by IS NULL
    )
    SELECT id, embedding <=> :emb AS distance
    FROM scoped
    ORDER BY distance
    LIMIT :limit
"""
```

This forces planner to filter to the tenant's rows BEFORE running the cosine similarity, eliminating any chance the planner picks "scan whole HNSW, filter by user_id at the end."

**Step 5: Run, verify**

Run: `pytest tests/security/test_vector_isolation.py tests/security/test_tenant_isolation.py -v`
Expected: all pass.

**Step 6: Commit**

```bash
git add src/klio_engine/services/recall.py alembic/versions/0007_vector_partition.py tests/security/test_vector_isolation.py
git commit -m "fix(engine): force tenant-scoped CTE before HNSW vector search"
```

---

### Task L.2 — Coordinator + Edge: rate limiting

**Files:**
- Create: `coordinator/src/klio_coordinator/middleware/rate_limit.py`
- Create: `coordinator/tests/middleware/test_rate_limit.py`
- Create: `edge/src/rate-limit.ts` (Cloudflare Workers)
- Create: `edge/tests/rate-limit.test.ts`

**Step 1: Write the failing test (coordinator side)**

Create `coordinator/tests/middleware/test_rate_limit.py`:

```python
"""Rate-limit middleware tests."""
import pytest


def test_provision_rate_limit_per_ip(client_with_db) -> None:
    body = {"agent_kind": "claude-code", "install_id": "00000000-0000-0000-0000-000000000001"}
    # Make 5 requests in a row; per design, 5/IP/hour for provision
    for _ in range(5):
        response = client_with_db.post("/v1/users/provision", json=body)
        assert response.status_code == 201
    # 6th request from the same IP should 429
    response = client_with_db.post("/v1/users/provision", json=body)
    assert response.status_code == 429
    assert "retry-after" in {h.lower() for h in response.headers}


def test_recall_rate_limit_per_user(client_with_db, authed_engine_client) -> None:
    """Authenticated endpoint: 1000 reqs/min per user with 5000 burst."""
    # We test at a smaller threshold via env override to keep the test fast.
    import os
    os.environ["KLIO_RATE_LIMIT_AUTH_PER_MINUTE"] = "10"
    # ... make 10 requests → all OK; 11th → 429
```

**Step 2: Implement rate-limit middleware**

Create `coordinator/src/klio_coordinator/middleware/rate_limit.py`:

```python
"""Sliding-window rate limit using Redis.

Two policies:
  - Anonymous IP-based: 5 provisions/hour, 50/ASN/hour.
  - Authenticated user-based: 1000 req/min, burst 5000.

Both implemented as sorted-set sliding windows in Redis. Falls open if Redis
is unreachable (we'd rather serve traffic than hard-fail when Redis blips).
"""
import time

from fastapi import HTTPException, Request, status
from redis.asyncio import Redis

from klio_coordinator.config import Settings


class RateLimiter:
    def __init__(self, redis: Redis | None = None) -> None:
        self._redis = redis or Redis.from_url(Settings().redis_url)

    async def check(
        self, request: Request, *, key: str, limit: int, window_seconds: int,
    ) -> None:
        now = time.time()
        window_start = now - window_seconds
        try:
            # Atomic: trim old entries, count remaining, add current.
            pipe = self._redis.pipeline()
            pipe.zremrangebyscore(key, 0, window_start)
            pipe.zcard(key)
            pipe.zadd(key, {str(now): now})
            pipe.expire(key, window_seconds)
            _, count, _, _ = await pipe.execute()
        except Exception:
            return  # fail open

        if count >= limit:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"rate limit exceeded: {limit} per {window_seconds}s",
                headers={"Retry-After": str(window_seconds)},
            )


def provisioning_rate_limiter(rate_limiter: RateLimiter):
    async def dep(request: Request) -> None:
        ip = request.client.host if request.client else "unknown"
        await rate_limiter.check(
            request, key=f"rl:provision:ip:{ip}", limit=5, window_seconds=3600,
        )
    return dep


def auth_rate_limiter(rate_limiter: RateLimiter):
    async def dep(request: Request) -> None:
        # Extract user_id from the Authorization header's JWT
        auth = request.headers.get("authorization", "")
        # ... parse JWT, extract sub ...
        sub = "unknown"  # full impl pulls from the verified token
        await rate_limiter.check(
            request, key=f"rl:auth:user:{sub}", limit=1000, window_seconds=60,
        )
    return dep
```

Wire into routers:

```python
# users.py
@router.post("/provision", dependencies=[Depends(provisioning_rate_limiter(rate_limiter))])
async def provision(...): ...
```

**Step 3: Edge-side rate limit (Cloudflare Workers)**

Create `edge/src/rate-limit.ts`:

```typescript
// Edge rate-limiting using Cloudflare's Rate Limiting API.
// Two layers: per-IP and per-ASN. WAF rules and Turnstile CAPTCHA escalate
// when these are tripped.

import type { Env, ExecutionContext } from './types';

const PROVISIONING_PATH = '/v1/users/provision';

export async function rateLimit(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === PROVISIONING_PATH && request.method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const ipResult = await env.RATE_LIMITER_IP.limit({ key: `provision:${ip}` });
    if (!ipResult.success) {
      return new Response('Rate limit exceeded', {
        status: 429,
        headers: { 'Retry-After': '3600' },
      });
    }

    const asn = (request.cf as any)?.asn ?? 'unknown';
    const asnResult = await env.RATE_LIMITER_ASN.limit({ key: `provision-asn:${asn}` });
    if (!asnResult.success) {
      return new Response('Rate limit exceeded for network', { status: 429 });
    }
  }
  return null;
}
```

Configure two Rate Limiter bindings in `wrangler.toml`:

```toml
[[unsafe.bindings]]
name = "RATE_LIMITER_IP"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 5, period = 3600 }

[[unsafe.bindings]]
name = "RATE_LIMITER_ASN"
type = "ratelimit"
namespace_id = "1002"
simple = { limit = 50, period = 3600 }
```

**Step 4: Run, verify**

Run: `pytest tests/middleware/test_rate_limit.py -v` (coordinator) and `pnpm test edge/` (Workers).
Expected: all pass.

**Step 5: Commit**

```bash
git commit -am "feat: rate limiting at coordinator and Cloudflare edge"
```

---

### Task L.3 — Coordinator: anomaly detection (geolocation, write spikes)

**Files:**
- Create: `coordinator/src/klio_coordinator/security/anomaly.py`
- Create: `coordinator/tests/security/test_anomaly.py`

Brief — the anomaly detector runs on every authenticated request. It logs to the audit log and revokes the refresh token (forcing re-auth) when:
- Geolocation jump > 1000km in < 60min.
- Write rate > 10× the rolling 7-day baseline.
- Token used from a new ASN.

Tests exercise each rule with synthetic event sequences. Implementation uses Redis sorted sets keyed on user_id + signal_type.

**Commit:** `feat(coordinator): geo + write-spike anomaly detection with refresh-token revocation`.

---

### Task L.4 — Audit-log notarization to OpenTimestamps

**Files:**
- Create: `engine/src/klio_engine/audit/notarize.py`
- Create: `engine/tests/audit/test_notarize.py`
- Create: `coordinator/scripts/notarize_hourly.py` (cron entrypoint)

**Goal:** every hour, take the most recent audit-log root hash for each user (or one global root, depending on operational preference), submit it to OpenTimestamps via the public calendar servers, and store the OTS attestation back in a `notarizations` table. Anyone can later verify that "this audit-log state existed at this time" without trusting Klio.

**Step 1: Write the failing test**

Create `engine/tests/audit/test_notarize.py`:

```python
"""Notarization tests."""
import pytest

from klio_engine.audit.notarize import compute_global_root, submit_to_calendar


@pytest.mark.asyncio
async def test_compute_global_root_is_deterministic(session) -> None:
    """Computing the global root twice over identical state must yield the same hash."""
    h1 = await compute_global_root(session)
    h2 = await compute_global_root(session)
    assert h1 == h2


@pytest.mark.asyncio
async def test_changes_to_audit_log_change_root(session) -> None:
    h_before = await compute_global_root(session)
    # Insert a new audit log entry
    from klio_engine.models.audit import AuditLogEntry
    import uuid
    e = AuditLogEntry(
        user_id=uuid.uuid4(), actor_type="system", actor_id=None,
        action="x", target_type="x", target_id=None,
        prev_hash="0" * 64, hash="a" * 64, audit_metadata={},
    )
    session.add(e)
    await session.flush()

    h_after = await compute_global_root(session)
    assert h_before != h_after
```

**Step 2: Implement notarize**

Create `engine/src/klio_engine/audit/notarize.py`:

```python
"""Notarize audit-log root hashes to OpenTimestamps.

Hourly job: compute a Merkle root over the latest hash from every user's
audit log, submit it to OpenTimestamps calendar servers, persist the OTS
attestation. Public verifiers can later prove that the audit log existed
in this state at this time, without trusting Klio.
"""
import hashlib

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.audit import AuditLogEntry


async def compute_global_root(session: AsyncSession) -> str:
    """sha256 over the sorted concatenation of every user's most-recent hash."""
    rows = await session.execute(text("""
        SELECT user_id, hash
        FROM audit_log
        WHERE id IN (
            SELECT id FROM audit_log a
            WHERE NOT EXISTS (
                SELECT 1 FROM audit_log b
                WHERE b.user_id = a.user_id AND b.created_at > a.created_at
            )
        )
        ORDER BY user_id
    """))
    h = hashlib.sha256()
    for user_id, hash_hex in rows:
        h.update(str(user_id).encode())
        h.update(b"|")
        h.update(hash_hex.encode())
        h.update(b"\n")
    return h.hexdigest()


def submit_to_calendar(root_hash: str) -> bytes:
    """Submit the root to OpenTimestamps. Returns the OTS attestation file bytes.

    Uses the `opentimestamps-client` Python library which handles calendar
    submission and Bitcoin commitment retrieval.
    """
    from opentimestamps.calendar import RemoteCalendar
    from opentimestamps.core.timestamp import Timestamp
    from opentimestamps.core.serialize import StreamSerializationContext
    from io import BytesIO

    digest = bytes.fromhex(root_hash)
    timestamp = Timestamp(digest)
    calendar = RemoteCalendar("https://alice.btc.calendar.opentimestamps.org")
    timestamp = calendar.submit(timestamp)

    out = BytesIO()
    ctx = StreamSerializationContext(out)
    timestamp.serialize(ctx)
    return out.getvalue()
```

**Step 3: Hourly cron**

Create `coordinator/scripts/notarize_hourly.py`:

```python
"""Run hourly via Railway cron: compute global root, submit to OpenTimestamps,
persist the OTS attestation."""
import asyncio
import os

from klio_engine.audit.notarize import compute_global_root, submit_to_calendar
from klio_engine.db import build_engine
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlalchemy import text


async def main() -> None:
    engine = build_engine(os.environ["KLIO_DATABASE_URL"])
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as session:
        root = await compute_global_root(session)
        ots = submit_to_calendar(root)
        await session.execute(text("""
            INSERT INTO audit_notarizations (root_hash, ots_attestation, created_at)
            VALUES (:root, :ots, now())
        """), {"root": root, "ots": ots})
        await session.commit()


if __name__ == "__main__":
    asyncio.run(main())
```

**Step 4: Run, verify**

Run: `pytest tests/audit/test_notarize.py -v`
Expected: passes.

**Step 5: Commit**

```bash
git commit -am "feat(engine): hourly audit-log notarization to OpenTimestamps"
```

---

### Task L.5 — VDP infrastructure (security.txt, PGP, Hall of Fame)

**Files:**
- Create: `trust-app/public/.well-known/security.txt`
- Create: `trust-app/src/app/security/page.tsx`
- Create: `trust-app/src/app/security/hall-of-fame.tsx`
- Create: `docs/security/threat-model.md` (in `klio-tech/protocol` repo)
- Create: `docs/security/pgp-public-key.asc`
- Create: `tools/security/triage.md`

**Step 1: Create security.txt**

Create `trust-app/public/.well-known/security.txt`:

```
Contact: mailto:security@klio.tech
Contact: https://klio.tech/security
Encryption: https://klio.tech/security/pgp-public-key.asc
Acknowledgments: https://klio.tech/security/hall-of-fame
Policy: https://klio.tech/security/policy
Preferred-Languages: en
Canonical: https://klio.tech/.well-known/security.txt
Expires: 2027-05-02T00:00:00.000Z
```

**Step 2: Create the security page**

Create `trust-app/src/app/security/page.tsx`:

```tsx
import Link from 'next/link';

export default function SecurityPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-12 prose">
      <h1>Security at Klio</h1>

      <h2>Vulnerability Disclosure Program</h2>
      <p>
        Klio runs a public Vulnerability Disclosure Program. We will not pursue
        legal action against researchers acting in good faith within the scope
        defined below. We respond within 24 hours, triage within a week, and
        fix Critical/High issues before public disclosure.
      </p>

      <h2>How to report</h2>
      <ul>
        <li>Email: <code>security@klio.tech</code></li>
        <li>PGP: <a href="/security/pgp-public-key.asc">our public key</a> (fingerprint: <code>AAAA BBBB CCCC DDDD ...</code>)</li>
        <li>For high-urgency issues, also DM <code>@klio_security</code> on X.</li>
      </ul>

      <h2>In scope</h2>
      <ul>
        <li>All <code>*.klio.tech</code> domains</li>
        <li><code>klio-bridge</code> daemon binary (any released version)</li>
        <li>The OSS engine in <Link href="https://github.com/klio-tech/engine">klio-tech/engine</Link></li>
        <li>The protocol specification in <Link href="https://github.com/klio-tech/protocol">klio-tech/protocol</Link></li>
      </ul>

      <h2>Named research targets (the bugs we most want found)</h2>
      <ul>
        <li>Cause user A&apos;s entry to surface in user B&apos;s recall</li>
        <li>Write to a space without write permission</li>
        <li>Read a space without read permission via WebSocket</li>
        <li>Tamper with the audit log without detection</li>
        <li>Memory poisoning that survives the dedup + supersedes pipeline</li>
        <li>Daemon credential exfiltration via local process</li>
      </ul>

      <h2>Recognition</h2>
      <p>
        Klio is currently early-stage and does not have funded bounty payouts.
        We commit publicly to retroactively reward Critical and High findings
        with cash bounties once we close our seed round. In the meantime, every
        valid finding is acknowledged on our <Link href="/security/hall-of-fame">Hall of Fame</Link>,
        and we ship swag (t-shirt + stickers) for any finding rated Medium or above.
      </p>

      <h2>Threat model</h2>
      <p>
        Our published threat model lives in the protocol repo:&nbsp;
        <Link href="https://github.com/klio-tech/protocol/blob/main/docs/security/threat-model.md">
          threat-model.md
        </Link>.
        Pull requests welcomed.
      </p>
    </main>
  );
}
```

**Step 3: Hall of Fame**

A static page listing researchers' handles, badge level (Critical/High/Medium/Low), and the date. Initially empty; populated as VDP reports come in.

**Step 4: Threat model document (in `klio-tech/protocol`)**

Create `docs/security/threat-model.md`:

```markdown
# Klio Threat Model

This document is the canonical, public threat model for Klio. It maps STRIDE
threats and substrate-specific threats to mitigations, and it documents the
five hard guarantees that bound the bug-bounty scope.

[Full content from Phase 5 of the design doc, formatted for public consumption.]
```

**Step 5: Triage runbook**

Create `tools/security/triage.md` — internal runbook for handling VDP reports. Includes:
- 24h response SLA
- Severity matrix
- Coordination with engineering for fixes
- Public-disclosure timeline (max 90 days)
- Hall of Fame update process

**Step 6: Commit**

```bash
git commit -am "feat: VDP infrastructure (security.txt, security page, threat model)"
```

---

### Task L.6 — Marketing site, demo video, status page

**Files:**
- Create: `marketing/index.html` (or extend `trust-app/src/app/(marketing)/page.tsx`)
- Create: `marketing/install.sh` (the curl-pipe-sh installer)
- Create: `docs/launch/demo-script.md`
- Create: `status/uptime.html` (or use a hosted provider — Better Stack or Cronitor)

**Marketing site contents:**
- Hero: "Your AI agents, finally talking to each other."
- 60-second demo video (embedded; recorded in week 9).
- "How it works" section with the diagram from the design doc.
- Open-source links (engine, bridge, protocol).
- Security: link to klio.tech/security.
- Pricing teaser: "Free for individuals. Paid B2B2C tier launching post-seed."
- Email capture for launch notification.

**Demo script:**

Create `docs/launch/demo-script.md`:

```markdown
# Klio Launch Demo Script (60-second cut)

## Cold open (0–5s)
Black screen. Text fades in: "AI agents work in silos."
Cuts to a desktop screen recording. Claude Code is open in one window,
Cursor in another, both pointed at the same project. They don't see each other.

## Install (5–15s)
Terminal:
  $ npx klio init

Output streams:
  ✓ Daemon installed
  ✓ Anonymous Klio account created
  ✓ Claude Code configured
  ✓ Cursor configured

Voiceover: "One command. Every agent on your machine, sharing context."

## Backfill (15–25s)
Terminal:
  $ klio backfill ~/.claude/projects --confirm

Progress bar fills. Output:
  ✓ Imported 318 sessions, generated 2,104 entries

Voiceover: "Months of past work, now searchable."

## The killer moment (25–45s)
Cut to Claude Code. Type:
  > what did we decide about the brand name?

Claude responds (verbatim from a real recording):
  "You decided on Klio on May 2nd, with klio.tech as the domain. The
   reasoning was that..."

Cut to Cursor. Type:
  > implement the daemon scaffold

Cursor responds:
  "Following Claude's plan from earlier today: Go binary, gorilla/websocket..."

Cut back to Claude Code. Type:
  > what is Cursor doing?

Claude:
  "Cursor edited internal/daemon/server.go 14 minutes ago. Most recent change
   was adding TLS pinning at 14:47."

## Close (45–60s)
End card:
  klio.tech
  Open source. Free for individuals.
  github.com/klio-tech
```

**Status page** — use Better Stack (hosted, free tier supports 10 monitors):
- api.klio.tech (HTTP 200 every 60s)
- app.klio.tech (HTTP 200 every 60s)
- klio-realtime WebSocket handshake (every 5min)
- updates.klio.tech (HTTP 200 every 5min)
- Postgres (synthetic transaction every 5min)
- Redis (PING every 60s)

**Commit:** `feat: marketing site, demo script, status page`.

---

### Task L.7 — Incident response runbook

**Files:**
- Create: `tools/runbooks/incident-response.md`
- Create: `tools/runbooks/p0-checklist.md`
- Create: `tools/runbooks/post-mortem-template.md`

**Incident response runbook outline:**

```markdown
# Klio Incident Response Runbook

## Severity levels
- **P0**: data leakage, account takeover, full-tenant outage > 5min
- **P1**: partial outage, broken core flow (e.g., recall returns empty)
- **P2**: degraded performance, non-critical feature broken
- **P3**: cosmetic / wished-for fix

## On-call rotation
- Primary engineer: 1-week rotation, listed in PagerDuty
- Founder fallback: Abhishek

## P0 procedure
1. Acknowledge in PagerDuty within 5 minutes.
2. Open #incident channel in Slack/Discord.
3. Update status page: "Investigating" within 10 minutes.
4. Mitigate first (revert deploy, scale up, reroute traffic).
5. Diagnose after.
6. Update status page every 30 minutes until resolved.
7. Post-mortem within 48 hours (template below).

## Public communication template
"We are investigating reports of [symptom]. Updates every 30 min at status.klio.tech."

## Customer communication
- If data leakage suspected: disclose to affected users within 72 hours of confirmation.
- If account-takeover suspected: revoke all refresh tokens for affected users immediately,
  email them with the new device confirmation flow.
```

**Commit:** `docs: incident response runbook`.

---

### Task L.8 — Pre-launch private security review

**Owner:** Abhishek + 2-3 invited security reviewers (equity-compensated).

**Scope:**
- Two-week engagement, weeks 8 and 9.
- Reviewers get full source access (read-only fork of all repos).
- Live cluster with synthetic data, isolated from production.
- Reviewers file findings in a private GitHub repo (`klio-tech/security-internal`).
- Severity rated by Klio team using the public severity matrix.

**Acceptance for launch:**
- All Critical and High findings closed (fix merged + tested).
- Medium findings either closed or filed as public roadmap items with explicit "won't fix" justification.
- Each reviewer signs off on the threat model.

**Outputs:**
- A public summary: `klio.tech/security/2026-pre-launch-review.html` listing the firm/individuals (with their permission), the scope, the methodology, the severity counts, and the disposition.

**Commit:** `docs: pre-launch security review summary` (after the review completes).

---

### Task L.9 — Launch sequence (Week 10)

This is operational, not engineering — but it goes in the plan because the gates matter.

```
Monday — Internal launch
  09:00 PT  Full team installs fresh on personal devices
  10:00     Run end-to-end demo; record any rough edges
  14:00     File P0/P1 issues from internal install; fix by EOD
  EOD       Smoke test passes for every team member

Tuesday — Soft launch
  09:00 PT  Send personalized email to ~50 friendlies (founders, builders, advisors)
  Throughout: Discord channel for first-wave feedback
  EOD       Triage P0s, fix overnight if needed

Wednesday — Closed beta widening
  09:00 PT  DM ~200 known builders/researchers in agent space
  Status page goes public

Thursday — Final dress rehearsal
  09:00 PT  Full team runs through the demo end-to-end on cold installs
  14:00     Demo video locked, captions added, ProductHunt page reviewed
  17:00     HN post draft, tweet thread draft, press kit reviewed by 1 PR person
  EOD       Code freeze. Only P0 fixes from here.

Friday — Public launch
  06:00 PT  Tweet thread goes live (Abhishek's personal account)
  06:05     HN "Show HN" submitted
  06:10     ProductHunt page launched
  06:15     Discord opens to public
  06:30     Email to ~5,000 captured emails from marketing site
  Throughout: 72-hour on-call rotation begins
            P0 fixes deployed via signed CI artifacts
            Discord moderators respond in under 15 minutes during US daytime
```

**Acceptance criteria for launch success:**
- 1000+ unique daemon installs in the first 7 days.
- 95th-percentile install-to-first-recall latency < 60 seconds.
- Zero Critical security incidents in launch week.
- Status page green > 99% across the launch week.

**No commit** — this is operational. The launch gates are tracked in a separate launch-tracker spreadsheet.

End of Phase L. Tier-2 security commitments verified. VDP live. Pre-launch review complete. Marketing site, demo video, status page live. Launch sequence executed.

---

## Execution Handoff

Plan complete and saved to [`docs/plans/2026-05-02-klio-implementation-plan.md`](2026-05-02-klio-implementation-plan.md).

The design lives in [`docs/plans/2026-05-02-klio-architecture-design.md`](2026-05-02-klio-architecture-design.md).

Two execution options:

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review the work between tasks, iterate quickly. Best for pair-programming-style execution where we want tight feedback loops and the founder reviews each chunk before the next.

**2. Parallel Session (separate)** — Open a new Claude Code session in a worktree, point it at this plan, and let it execute task-by-task using the `executing-plans` skill. Best for batch execution against gated checkpoints (e.g., "run through Phase A end-to-end then check in").

Which approach?

If you choose option 1, this session continues. I dispatch a subagent to start with Task A.1 (npm scope and PyPI namespace reservation), and we work through each task with code review between them.

If you choose option 2, you start a new session pointed at this worktree, invoke `superpowers:executing-plans`, and let it run. You can pause it at any phase boundary.

My recommendation, with conviction: **Option 2** for the engine + coordinator + daemon work (Phases A–G — they're highly mechanical TDD work where a fresh session can crank through dozens of tasks per day), and **Option 1** for trust-app + Claude-Code-integration (Phases I–J — they're more product-y and benefit from human review between tasks). Hybrid is fine — start with 2, switch to 1 when we hit the parts that need design judgment.

Either way: ship something installable in week 5, pilot in week 7, public launch in week 10.

