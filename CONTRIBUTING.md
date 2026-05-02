# Contributing to Klio

Thank you for considering contributing to Klio. This document covers
how to file issues, propose features, and submit code. Klio is a
small, ambitious project — we welcome contributions of every size.

## Quick links

- 🐛 [File a bug](https://github.com/klio-tech/klio/issues/new?template=bug.yml)
- ✨ [Propose a feature](https://github.com/klio-tech/klio/issues/new?template=feature.yml)
- 🔐 [Report a security vulnerability](SECURITY.md) (do **not** use the public issue tracker)
- 📜 [Code of Conduct](CODE_OF_CONDUCT.md)
- ⚖️ [Licensing](LICENSING.md)

## How we work

Klio is at v0 — the architecture is set, the major components exist
and are tested locally, but APIs may still shift. Larger contributions
should start with a quick "intent to implement" issue or discussion
so we can avoid duplicate work and steer toward the right shape.

Smaller contributions (typo fixes, doc improvements, small bug fixes,
adding a new agent adapter) — go straight to a PR.

## Setting up locally

The full setup is in [the README](README.md#quick-start). Short version:

```bash
git clone https://github.com/klio-tech/klio.git
cd klio
make first-run        # docker, ollama, migrations, binaries
make engine &         # FastAPI engine in one terminal
KLIO_USE_FILE_KEYCHAIN=1 KLIO_API_URL=http://127.0.0.1:8000 \
  /tmp/klio init
KLIO_USE_FILE_KEYCHAIN=1 KLIO_API_URL=http://127.0.0.1:8000 \
  /tmp/klio daemon &
docker compose up -d trust-app
```

You should now be able to:

- Hit the engine at `http://127.0.0.1:8000/health`
- Open the dashboard at `http://127.0.0.1:3000`
- Talk MCP through `/tmp/klio-mcp` over `~/.klio/bridge.sock`

## Running the test suites

```bash
make test                  # engine (97 stub tests) + bridge (13 packages)
make test-ollama           # the 2 integration tests requiring a live Ollama
cd trust-app && npm run typecheck && npm run build
```

CI on GitHub Actions runs all three on every PR.

## Picking what to work on

Good first issues:

- Open issues tagged `good-first-issue` (we'll be filling these up
  shortly)
- Bug fixes for anything in [HANDOFF.md](HANDOFF.md)'s "What was
  deliberately not done locally" list that you can validate
- New agent adapters — `Cursor` and `Codex` are highest priority;
  the existing `bridge/internal/agentadapters/claude_code.go`
  is the reference implementation
- Adding embedding models to `engine/src/klio_engine/services/embedding_models.py`
  (any 768/1024/1536-dim model that LiteLLM speaks works
  out-of-the-box)
- Per-language SDKs (Python, JS/TS, Go) that wrap the engine's
  `/v1/...` endpoints

Open architectural questions in [docs/plans](docs/plans).

## Pull request workflow

1. **Fork & branch.** Branch names: `feat/<short-name>`,
   `fix/<short-name>`, `docs/<short-name>`, `test/<short-name>`.

2. **Write tests first.** Klio is TDD-disciplined — if your change
   isn't covered by a test, expect a request to add one.
   - Engine: `pytest` in `engine/tests/`. New API endpoints get
     integration tests against a real Postgres.
   - Bridge: `go test ./...`. Use the `agentadapters` test patterns
     for adapter-style code.
   - Trust-app: typecheck (`tsc --noEmit`) + build must pass; we'll
     add Playwright e2e in v0.x.

3. **Keep PRs focused.** One concern per PR is much easier to review
   than ten changes in a single branch. Aim for ~200 lines of
   diff per PR; bigger is fine but expect more back-and-forth.

4. **Use Conventional Commits.** Examples:

   - `feat(bridge): cursor adapter`
   - `fix(engine): recall returns empty list when space deleted`
   - `docs: clarify embedding model dim selection`
   - `test(bootstrap): add idempotency test for re-init`
   - `chore(deps): bump pgvector to 0.8.0`

5. **Sign your commits is optional but encouraged.** `git commit -s`
   appends a `Signed-off-by:` line, the [DCO](https://developercertificate.org)
   default for projects without a formal CLA.

6. **Open the PR.** Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md);
   the auto-filled checklist makes review faster.

7. **CI must pass before merge.** Engine tests, bridge tests,
   trust-app build, and a basic security scan all run on every PR.
   We don't merge red PRs.

## Style guides

### Python (engine)

- PEP 8 via `black` and `ruff`. Both run as pre-commit hooks; see
  `engine/pyproject.toml`.
- Type hints on every public function. We don't enforce mypy strict
  yet but we will.
- Async-first for I/O. SQLAlchemy uses the async session.
- Docstrings on modules and public functions explain *why*, not
  just *what*.

### Go (bridge)

- `gofmt` enforced. `goimports` on save.
- Stdlib > third-party where reasonable. We've kept the dep tree
  small (uuid, redis, sqlite, jose) and want to keep it that way.
- Interfaces small and focused. The `agentadapters.Adapter` interface
  is a good model: 4 methods, no surprises.
- Errors wrapped with `%w` so callers can `errors.Is/As`.

### TypeScript (trust-app)

- React 19 + Next.js 15 App Router. Server Components by default;
  client components only where interactivity is needed.
- Type imports separated (`import type { X } from ...`).
- Inline styles are fine for now (no Tailwind in the OSS repo);
  CSS variables in `globals.css` for the few colours we do use.

### Documentation

- Plain English. Avoid acronyms that aren't widely understood
  (MCP, JWT, ACL, KMS are fine; project-specific abbreviations
  should be defined on first use).
- Code blocks must be runnable as-is. If a snippet needs context,
  show it.

## What won't be accepted

These are out of scope for this repo:

- Klio Cloud features (per-project auto-routing, premium connectors,
  team RBAC, hosted SSO, billing) — those live in the private
  Klio Cloud repo.
- Anything that adds telemetry / phone-home behaviour to the OSS.
  Klio is local-first; we don't want analytics in the open daemon.
- Major architectural rewrites without prior discussion. The shape
  set in `docs/plans/2026-05-02-klio-architecture-design.md` is
  intentional; please open an RFC issue before proposing significant
  redesigns.

## License of contributions

By submitting a PR you agree that your contribution is licensed
under Apache 2.0, as the rest of the repo is. We don't currently
require a CLA. See [LICENSING.md](LICENSING.md) for the full
licensing model.

## Releases

We tag releases as `vMAJOR.MINOR.PATCH`. Release notes go in
[CHANGELOG.md](CHANGELOG.md) (created at first tag). Releases are
signed with Sigstore once we set that up post-launch.

## Help & questions

- Discussion: [GitHub Discussions](https://github.com/klio-tech/klio/discussions)
- Email the author: contact@klio.tech
- Klio website: [klio.tech](https://klio.tech)
