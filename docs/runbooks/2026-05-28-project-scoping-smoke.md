# Per-project memory scoping — end-to-end smoke runbook

**Release:** v0.7.0
**Date:** 2026-05-28
**Owner:** whoever is cutting the release
**Time budget:** ~10 minutes if the stack is already up; ~20 minutes from cold.

This runbook verifies the v0.7.0 promise end-to-end: a `recall` from
inside a project sees that project's memories only, and an explicit
`project="any"` returns the cross-project blend.

Run this before tagging `v0.7.0`. If any step fails, fix and re-run from
the top — partial state is fine to leave in the database, the assertions
are about what each project sees, not absolute row counts.

> **Style note (first runbook in this directory):** Match this layout
> for future runbooks. Each step has a concrete command, an explicit
> **Expected:** line, and a fallback in Section 4. Code blocks always
> carry a language tag (`bash`, `sql`, `text`). No screenshots — every
> assertion has to be reproducible from a terminal.

---

## 1. Success criteria

A passing run satisfies all five:

1. **Project A scoping.** `recall` issued from inside Project A's
   working directory returns Project A's entries plus any
   NULL-`project_id` legacy entries — never Project B's.
2. **Project B scoping.** `recall` issued from inside Project B's
   working directory returns Project B's entries plus NULLs — never
   Project A's.
3. **`project="any"` escape hatch.** `recall(query, project="any")`
   issued from inside *either* project returns the union of all the
   user's entries (Project A's, Project B's, and any NULLs).
4. **Named other-project escape hatch.** `recall(query, project=<remote of Project B>)`
   issued from inside Project A returns Project B's entries only —
   not the union, and not Project A's.
5. **Database state matches.** `entries.project_id` is non-NULL for
   every entry written during this run. Project A's entries all share
   one `project_id`, Project B's all share a different `project_id`,
   and the per-project counts equal what was written in steps 2/3.

---

## 2. Prerequisites

### 2.1 Stack up

```bash
docker compose ps
```

**Expected:** `postgres`, `redis`, `engine`, `bridge` all `Up (healthy)`.
`ollama` and `trust-app` are optional for this runbook. If anything is
down:

```bash
docker compose up -d postgres redis engine bridge
```

### 2.2 Klio initialised

```bash
klio status
```

**Expected:** prints an authenticated user + a `~/.klio/...` config
path. If it prints `no Klio credentials found`, run `klio init` and
finish onboarding first.

### 2.3 Two real git repos

Three ways to satisfy this — pick the one that matches your situation:

- **Option A (preferred — most realistic):** use two of your actual
  project directories. Skip to Section 3.
- **Option B:** `git clone` any two public repos into `~/scratch/`.
- **Option C (lowest friction if you don't have repos handy):**
  synthesise them.

  ```bash
  mkdir -p ~/scratch && cd ~/scratch
  for r in repo-a repo-b; do
      mkdir "$r" && cd "$r"
      git init -q
      git remote add origin "git@github.com:klio-smoke/$r.git"
      echo "$r" > README.md && git add README.md
      git -c user.email=smoke@klio.tech -c user.name=Smoke \
          commit -q -m "init"
      cd ..
  done
  ```

  This creates `~/scratch/repo-a` and `~/scratch/repo-b` with distinct
  `origin` remotes. Either remote being reachable on GitHub is **not
  required** — the bridge only reads `git config --get remote.origin.url`,
  it never connects to the remote.

For the rest of this runbook, substitute the two paths/remotes for
whichever option you chose. The walkthrough assumes:

- Project A path: `~/scratch/repo-a`, remote `git@github.com:klio-smoke/repo-a.git`
- Project B path: `~/scratch/repo-b`, remote `git@github.com:klio-smoke/repo-b.git`

### 2.4 Sanity-check the remotes

```bash
git -C ~/scratch/repo-a remote -v
git -C ~/scratch/repo-b remote -v
```

**Expected:** each prints a non-empty `origin` line pointing at a
distinct URL. If either is empty, the bridge will fall back to
`repo_root_path` resolution — still correct, but you lose the assertion
that `git_remote` is populated in step 7.

---

## 3. Write an entry from Project A

```bash
cd ~/scratch/repo-a
claude  # or whichever launcher you use
```

In the Claude Code session, prompt:

> Remember that this project uses TypeScript strict mode.

**Expected:** Claude acknowledges via the `remember` tool (or another
write tool). The bridge's `UserPromptSubmit` hook fires, calls
`project.Resolve(cwd)`, ensures the project row exists, and writes
the entry with `project_id` set.

Leave the session open or quit — doesn't matter.

---

## 4. Write an entry from Project B

```bash
cd ~/scratch/repo-b
claude
```

Prompt:

> Remember that this project uses Python 3.12 and mypy --strict.

**Expected:** same hook flow as Section 3, but with Project B's
`project_id`. Quit when done.

---

## 5. Recall from Project A — scoped

```bash
cd ~/scratch/repo-a
claude
```

Prompt:

> What do you remember about this project?

**Expected:** Claude invokes `recall` (no `project` arg) and the
response mentions **TypeScript strict mode**. It must NOT mention
Python 3.12. If it mentions both, scoping is broken — see Section 7.

Quit.

---

## 6. Recall from Project B — scoped

```bash
cd ~/scratch/repo-b
claude
```

Prompt:

> What do you remember about this project?

**Expected:** mentions **Python 3.12 / mypy**, does NOT mention
TypeScript. Quit.

---

## 7. Cross-project escape hatch — `project="any"`

From either repo:

```bash
cd ~/scratch/repo-a
claude
```

Prompt:

> Use Klio's recall tool with project="any" to find what languages
> I prefer across all my projects.

**Expected:** Claude calls `recall(query=..., project="any")` and the
response references BOTH TypeScript-strict AND Python 3.12. If it
only returns one, the `project="any"` branch in
`_resolve_project_arg` is misbehaving — see Section 9.

---

## 8. Named other-project escape hatch

Still inside `~/scratch/repo-a`:

> Use Klio's recall tool with project="git@github.com:klio-smoke/repo-b.git"
> to recall what you know about that project.

**Expected:** Claude calls `recall(query=..., project="git@github.com:klio-smoke/repo-b.git")`
and the response references **Python 3.12 only**, NOT TypeScript and
NOT the union. Substitute your actual Project B remote.

---

## 9. SQL spot-check — confirm DB state matches user-visible behaviour

The user-facing assertions above (Sections 5–8) tell us the API
behaved correctly. This step confirms the underlying tagging is also
correct — so if a future regression breaks the API but leaves writes
correct, or vice-versa, the spot-check tells us which side moved.

```bash
docker compose exec -T postgres psql -U klio -d klio -c \
  "SELECT p.display_name,
          p.git_remote,
          COUNT(e.id) AS entries
   FROM projects p
   LEFT JOIN entries e ON e.project_id = p.id
   GROUP BY p.id, p.display_name, p.git_remote
   ORDER BY p.display_name;"
```

**Expected:** at least two rows whose `display_name` reflects the git
org/repo (e.g., `klio-smoke/repo-a` and `klio-smoke/repo-b`), each
with `entries >= 1`, and `git_remote` populated (not NULL) for both.

If you want to see the entries' raw `project_id` distribution:

```bash
docker compose exec -T postgres psql -U klio -d klio -c \
  "SELECT project_id, COUNT(*) FROM entries GROUP BY project_id ORDER BY COUNT(*) DESC;"
```

**Expected:** two non-NULL `project_id` groups with count >= 1 each,
plus optionally a NULL group (legacy entries from before v0.7).

---

## 10. Failure modes + diagnostics

Run through these in order if any step above failed.

### 10.1 Hook didn't fire (Sections 3 or 4 wrote nothing)

```bash
klio status
ls ~/.klio/
docker compose logs bridge --tail 100 | grep -i hook
```

Common cause: the hook path isn't registered with Claude Code. Re-run
`klio init` from inside the repo and re-try.

### 10.2 Entries written but `project_id IS NULL`

The bridge's `project.Resolve` is failing — most often because `git`
isn't on PATH inside the bridge container, or the hook payload's `cwd`
field is empty / wrong.

```bash
docker compose logs bridge --tail 100 | grep -E "project|resolve"
docker compose exec -T bridge which git
```

Then inspect a recent entry's row:

```bash
docker compose exec -T postgres psql -U klio -d klio -c \
  "SELECT id, project_id, kind, created_at FROM entries ORDER BY created_at DESC LIMIT 5;"
```

### 10.3 Cross-project leak (Section 5 returns Project B's entry, or vice-versa)

Two possible culprits. Bypass the agent layer and call the engine
directly to isolate which.

```bash
# Replace <space_id> with your active space — `klio status` prints it.
# Replace <token> with the bridge's auth token (env BRIDGE_AUTH or
# whatever your local config uses).
curl -sS -X POST "http://localhost:8080/v1/spaces/<space_id>/recall" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"query":"what language","project":"git@github.com:klio-smoke/repo-a.git","limit":10}' | jq .
```

- If this returns Project B's entry → the engine's filter is broken.
  Inspect `_resolve_project_arg` and `RecallService.recall`.
- If this correctly returns Project A's only → the bridge's recall
  proxy is sending the wrong `project` value or no value. Check
  `bridge/internal/hooks` and the MCP recall handler.

### 10.4 `project="any"` returns empty (Section 7 finds nothing)

The engine's `_resolve_project_arg` is misinterpreting `"any"` as a
remote-lookup, which then 404s. Repeat the curl above with
`"project":"any"` and confirm response shape. Expected: 200 with the
union of entries.

### 10.5 SQL spot-check shows projects but `git_remote IS NULL`

The bridge fell back to `repo_root_path` resolution (Section 2.4
flagged this risk). Re-verify `git -C <repo> remote -v` shows an
`origin`. If it does and the spot-check still shows NULL, the bridge
isn't shelling `git config` from the right cwd — check bridge logs.

### 10.6 Test-DB pollution from a prior run trips conftest guardrail

This only applies if you're running engine tests against a separate
`klio_test` DB after a smoke run that polluted shared state.

```bash
docker compose exec -T postgres psql -U klio -d klio_test -c \
  "DELETE FROM public.users WHERE email_hash IS NULL;"
```

> Note: this is for the **test** database (`klio_test`), not the
> production-shape `klio` DB used by the smoke runbook. Do NOT run
> destructive cleanups against `klio` — re-running this runbook is
> additive and safe.

---

## 11. After a successful smoke

Mark **G1** complete in the implementation plan
(`docs/plans/2026-05-27-per-project-memory-scoping-implementation-plan.md`).

Proceed to **G2** — CHANGELOG insert and `npm version 0.7.0 --no-git-tag-version`.

Once G2 lands and `engine`, `bridge`, and `npm` test suites are all
green locally, hand back to the user for explicit push approval. The
release-images workflow publishes container images automatically on
tag push (`v0.7.0`).
