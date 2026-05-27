# Per-project memory scoping — design

**Status:** approved, pending implementation plan
**Target release:** v0.7.0
**Date:** 2026-05-27

## Problem

Klio writes every captured memory into the user's single active space.
Every Claude Code session, regardless of which project the user is
working on, dumps into the same pool. When Claude calls `recall`,
pgvector returns the top-k semantically nearest entries with no
project context — so half the results come from unrelated repos.

Observed failure mode (user's words, lightly paraphrased): "Claude
wants to be pushed with data from Klio, but the data is from a
different project, so Claude rejects it." Two costs follow:

1. **Wasted tokens + latency.** Every recall ships cross-project
   noise that Claude has to mentally filter.
2. **Correctness risk.** When Claude doesn't filter, it accidentally
   applies Project B's preferences / decisions to Project A.

The bigger the pool grows over time, the worse the signal-to-noise
gets. This is the dominant blocker to Klio being useful at multi-
project scale, which is the actual shape of every serious developer's
workday.

## Decision

Three layers, distinct jobs:

1. **Spaces** stay as they are today — user-controlled coarse grouping
   (Personal / Work / Side). Per-space embedding model, per-space KMS
   key. Power-user lever.
2. **Projects** — new concept. Auto-detected from git context, used
   to tag every write and filter every read. Invisible to the user
   for the 95% common case.
3. **Recall scoping** — recall defaults to the active project's
   memories; an explicit `project=any` or `project=<remote>` widens
   the search.

A **promote-to-space escape valve** handles the rare project that
needs harder isolation (a different embedding model, isolated KMS,
atomic forget). The project is elevated from "tagged inside the
default space" to "owns a dedicated space" via a one-shot command.

### Why not make spaces themselves the project boundary?

Considered. Rejected because:

- pgvector ANN search on a single growing index scales linearly and
  is happy into the tens of millions of vectors. Splitting into N
  per-project indexes adds maintenance overhead with no per-query
  win on the single-project hot path.
- Cross-project recall (which the user explicitly wants as the
  escape hatch) forces a fan-out over N indexes that grows linearly
  with project count. A single tagged index pays zero extra cost
  for cross-project queries — just drop the WHERE.
- Spaces are a user-facing product concept ("per-space pluggable
  embedding models" is part of Klio's marketing). Redefining spaces
  as auto-detected per-repo buckets breaks the existing model. The
  user would end up with 30 spaces they never created and have to
  reason about which is which.

The chosen design preserves spaces' user-facing semantics and adds
a strictly-invisible second layer underneath.

## Data model

### New table

```sql
CREATE TABLE projects (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    git_remote            TEXT,                                       -- e.g. git@github.com:klio-tech/klio.git
    repo_root_path        TEXT,                                       -- fallback when no remote
    display_name          TEXT NOT NULL,                              -- "klio-tech/klio" or basename
    dedicated_space_id    UUID REFERENCES spaces(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uniqueness: git_remote when present, else repo_root_path. Two
-- partial unique indexes give us the right semantics without a
-- complex check constraint.
CREATE UNIQUE INDEX projects_user_remote_idx
    ON projects (user_id, git_remote)
    WHERE git_remote IS NOT NULL;

CREATE UNIQUE INDEX projects_user_path_idx
    ON projects (user_id, repo_root_path)
    WHERE git_remote IS NULL AND repo_root_path IS NOT NULL;
```

### Existing `entries` table

Add one column:

```sql
ALTER TABLE entries ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX entries_project_id_idx ON entries (project_id);
```

`NULL` means un-scoped (legacy entry, or a hook fired from a
non-detectable context like `~`). NULL entries surface in every
project's recall — safe default. The user can later run a
recategorize tool to manually assign them; out of scope for v0.7.

## Bridge changes

### New module: `internal/project`

```go
// Resolve maps a working directory to a project_id, creating the
// project row on first observation. Caches results in an LRU keyed
// by abspath(cwd) — the hot path is a hook fire and we don't want
// to re-shell `git config` on every event.
package project

func Resolve(ctx context.Context, cwd string) (uuid.UUID, error)
```

Resolution order:

1. `cd <cwd> && git config --get remote.origin.url` — strongest
   signal. Survives directory renames; canonical across worktrees.
2. `cd <cwd> && git rev-parse --show-toplevel` — repo root abspath.
   Used when git exists but no remote.
3. Abspath of `cwd` itself — when there's no git at all. Survives
   if the user doesn't rename the folder.

Each hook event captures its own cwd, so a session that drifts
across projects produces correctly-tagged entries per event.

### Hook integration

Every hook handler (already wired in `bridge/internal/hooks`) calls
`project.Resolve` before forwarding the captured payload to the
engine, attaching `project_id` to the write request.

### Recall proxy

The MCP `recall` handler in the bridge attaches the active
project_id to the engine request as a `project_filter` parameter
unless the caller explicitly passed `project=...` in the tool call.

## MCP shape

```
recall(query="how did we handle JWT refresh")
  → current project's entries only

recall(query="how did we handle JWT refresh", project="any")
  → cross-project, behaves like today

recall(query="how did we handle JWT refresh", project="klio-tech/klio")
  → named other project by git remote (canonical form)

recall(query="…", project="<project_id_uuid>")
  → named by UUID (rare; useful when remote is ambiguous)
```

Write tools (`remember`, `observe`, `decide`, `note`, `plan`) do NOT
take a `project` parameter. Writes are always tagged with the project
the hook fired in. Letting the LLM override the source project on a
write would be a footgun — the project is metadata about *where the
memory came from*, not *who it's about*.

## Migration

### Goal

Backfill `project_id` on existing entries where session metadata
captured the cwd at the time of write, so existing memories don't
all dump into NULL on day one.

### Mechanism

1. Apply the new `projects` table and `entries.project_id` column.
2. Walk `sessions` table. For each session row with a captured
   `cwd` field, run `project.Resolve(cwd)` → creates the project row
   if needed → updates all entries that belong to this session with
   the resolved `project_id`.
3. Entries from sessions without cwd metadata stay `project_id =
   NULL`. They surface in every project's recall (safe — they
   weren't isolated before, and the user can recategorize later).

### Observability

Bridge logs a one-line summary at first post-migration startup:

```
[migration] auto-tagged 8412 entries across 14 projects;
            672 entries un-categorizable (no cwd metadata),
            will surface in all projects' recall.
```

So users know where they stand without having to run a query.

### Open question

The migration assumes `sessions` captures cwd. **Needs verification
in the implementation plan.** If today's session schema doesn't have
cwd, the migration story degrades to "all legacy entries NULL", which
is still safe but less satisfying. A pre-migration audit step gates
the decision.

## Promote-to-space escape valve

For the rare project that needs harder isolation than tag-filtering
provides — typically because it needs a different embedding model
(code-heavy repo wants a code embedding), isolated KMS key (client
work that must not co-mingle), or atomic "forget this project"
semantics.

```
klio project promote <git-remote-or-display-name> --space=<existing-space-id-or-name>
klio project promote <git-remote-or-display-name> --embedding=<model>
```

- `--space`: future memories for this project route to the named
  existing space.
- `--embedding`: creates a new dedicated space with that embedding
  model, then routes the project there.
- `--migrate` (optional flag on either): moves existing entries
  with this project_id into the new space. Default is to leave
  them where they are; project_id still keeps recall correct.

After promotion, the project's row has `dedicated_space_id` set; the
bridge's recall proxy routes that project's queries to the dedicated
space instead of the default.

## Edge cases

- **No git**: cwd abspath becomes the identifier. Survives unless
  the user renames the folder. Two repos with same basename in
  different paths stay distinct.
- **cwd drifts mid-session**: each hook event captures its own cwd.
  By design — a session that legitimately spans projects produces
  per-event-correct tags.
- **Worktrees**: `git remote get-url origin` resolves identically
  across linked worktrees, so they share the project. Correct.
- **Detached HEAD**: still has a remote configured; resolves fine.
- **Monorepo with multiple sub-projects**: v0.7 = one project per
  remote (the root). Sub-project boundaries via `.klio/project.toml`
  at a sub-root deferred to **v0.8**.
- **Hook fires from `~` or a non-project dir**: project resolves to
  abspath of `~`, which becomes its own "global home" project.
  Recall from there returns entries tagged with that path + NULL
  entries. Won't accidentally leak across project boundaries.

## Testing

### Unit

- `internal/project.Resolve` — git remote present, git no remote,
  no git at all, worktree, detached HEAD.
- LRU cache hit/miss correctness; invalidation on missing dir.

### Engine

- Recall filter behavior across `project_id IN`, `project_id != X`,
  `project_id IS NULL`, and combinations with `project="any"`.
- Promote-to-space routing — entries written after promotion land in
  the dedicated space, not the default.

### Migration

- Synthetic session table with mixed cwd presence; assert post-
  backfill counts match expected per-project and NULL totals.
- Idempotency: running migration twice doesn't duplicate projects
  or re-tag already-tagged entries.

### Integration

- End-to-end: hook fires from Project A → `recall` from Project A
  returns A's entries; from Project B returns B's only; `project=any`
  returns both. Verified across a real two-repo fixture.

### Manual

- Cross-project escape hatch: invoke `recall(query=..., project="any")`
  from inside Project A and verify expected blend of A + B results.

## Open questions

1. **Sessions-cwd assumption** — verify in the implementation plan
   whether today's session schema captures cwd. If not, migration
   story degrades to all-NULL (safe but less useful).
2. **Monorepo deferral to v0.8** — confirmed acceptable for now;
   most users aren't in monorepos. If the user's daily flow includes
   one, this gets bumped to v0.7.
3. **Promote-to-space command location** — sketched as `klio project
   promote`. Could alternatively live under `klio space` to keep
   isolation-related commands together. Decision: keep as `klio
   project` since it's per-project, not per-space.

## Out of scope (deferred)

- Sub-project boundaries inside a monorepo (v0.8 via `.klio/project.toml`).
- Manual recategorize tool for NULL legacy entries (low priority;
  NULL is safe).
- UI surfaces in trust-app for listing projects, viewing per-project
  counts, promote-to-space wizard (post-v0.7; CLI first).

## Implementation plan

To be written next via the `superpowers:writing-plans` skill. See
`docs/plans/2026-05-27-per-project-memory-scoping-implementation-plan.md`
once written.
