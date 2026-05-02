<!--
  Thanks for the PR! Please fill out the sections below — it makes
  review faster and avoids back-and-forth on basics.
-->

## What this PR does

<!-- One-paragraph summary. What changed and why. -->

## How it was tested

<!--
  - Engine: which pytest files / specific tests?
  - Bridge: which `go test` packages?
  - Trust-app: did `npm run typecheck && npm run build` pass?
  - Manual: any e2e walkthrough you ran?
-->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (requires migration / version bump)
- [ ] Documentation only
- [ ] Test only / refactor

## Component(s) touched

- [ ] Engine (`engine/`)
- [ ] Bridge daemon (`bridge/`)
- [ ] MCP shim (`bridge/cmd/klio-mcp`)
- [ ] Agent adapters (`bridge/internal/agentadapters`)
- [ ] Trust-app (`trust-app/`)
- [ ] Docs / README / HANDOFF
- [ ] CI / build config
- [ ] Schema / migrations

## Migration notes

<!--
  If this PR adds a new alembic migration, requires re-init, or
  changes the on-disk format of anything under ~/.klio, describe
  what existing users need to do. Otherwise: "None."
-->

## Pre-submit checklist

- [ ] Conventional Commits subject (`feat:`, `fix:`, `docs:`, `test:`, etc.)
- [ ] Tests added or updated; full suite passes locally
- [ ] No new dependencies without explanation in the PR description
- [ ] No telemetry / phone-home / analytics added (Klio is local-first)
- [ ] No `Co-Authored-By: Claude` or other AI attribution in commits
- [ ] Author identity = me, not an AI tool
- [ ] If touching crypto / auth / ACL / hooks: I read [SECURITY.md](../SECURITY.md)
- [ ] If proposing a Cloud-only feature: I checked it belongs here, not in Klio Cloud
- [ ] Doc updated where the change is user-visible

## Related

<!-- Issue numbers (`Closes #123`), prior PRs, RFC discussions. -->
