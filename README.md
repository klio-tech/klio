# Klio

Your AI agents, finally talking to each other.

This is the monorepo for Klio v0 — the agent-to-agent collaboration substrate.

## Repos (logical, all in this monorepo for v0 development)

| Path | Purpose |
|---|---|
| `engine/` | OSS substrate engine (Postgres + pgvector, ACL, extraction pipeline, plugin host) |
| `coordinator/` | Cloud identity / provisioning / billing service |
| `realtime/` | WebSocket fan-out service (Go) |
| `bridge/` | Local daemon + CLI + MCP shim (Go) |
| `protocol/` | OpenAPI specs, MCP tool schemas, contract tests |
| `trust-app/` | `app.klio.tech` — Next.js trust UI |
| `infra/` | Docker compose, init scripts, terraform (deferred) |
| `docs/` | Design + implementation plans |

## Local development

Bring up Postgres + Redis:

```bash
docker compose up -d
```

Each subpackage has its own `Makefile` / `pyproject.toml` / `go.mod`. See its README.

## Source of truth

- [Architecture & v0 design](docs/plans/2026-05-02-klio-architecture-design.md)
- [Implementation plan (12 phases, ~100 TDD tasks)](docs/plans/2026-05-02-klio-implementation-plan.md)
