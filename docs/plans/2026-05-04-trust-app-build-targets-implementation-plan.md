# trust-app Build-Target Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split `trust-app` into two build targets — `local` (ships in the GHCR image pulled by `npx @klio-tech/klio init`) and `public` (deployed to klio.tech via Railway) — sharing one source tree under one repo.

**Architecture:** Route groups (`(local)`, `(public)`) gated by a `next.config.js` webpack rule that swaps the unwanted group's modules for an empty stub via `ignore-loader`. Two GHCR images built from the same Dockerfile via a `KLIO_BUILD_TARGET` build-arg. A `test:bundle-isolation` script greps each build's `.next/` output for cross-target string leaks and fails CI if any slip through.

**Tech Stack:** Next.js 16, React 19, TypeScript strict, `ignore-loader` (build-time only), Docker multi-stage, GitHub Actions matrix.

**Source design:** `docs/plans/2026-05-04-trust-app-build-targets-design.md`

**Branch + push policy:** Work on `feat/trust-app-build-targets`. **Do not push to GitHub** — commit locally only until the user approves. Mirrors the 0.3.x policy.

---

## Section A — Build-target plumbing (no behaviour change yet)

Goal: get the `KLIO_BUILD_TARGET` env var threaded through `next.config.js` and package scripts WITHOUT moving any routes. Both `npm run build:local` and `npm run build:public` should produce identical output to today's `npm run build` because no exclusion rules exist yet.

### Task A1: Add `ignore-loader` dev dependency

**Files:**
- Modify: `trust-app/package.json` (devDependencies)

**Step 1:** Add the package:

```bash
cd /Users/thakurg/Me/klio/trust-app && npm install --save-dev ignore-loader
```

**Step 2:** Verify `package.json` `devDependencies` now lists `ignore-loader`:

```bash
grep '"ignore-loader"' trust-app/package.json
```
Expected: a single line, version pinned.

**Step 3:** Commit.

```bash
cd /Users/thakurg/Me/klio
git add trust-app/package.json trust-app/package-lock.json
git commit -m "deps(trust-app): add ignore-loader for build-target webpack rule"
```

### Task A2: Add `build:local`, `build:public`, `dev:local`, `dev:public` scripts

**Files:**
- Modify: `trust-app/package.json` (scripts block)

**Step 1:** Edit the scripts block to:

```json
"scripts": {
  "dev": "KLIO_BUILD_TARGET=${KLIO_BUILD_TARGET:-local} next dev -p 3000",
  "dev:local": "KLIO_BUILD_TARGET=local next dev -p 3000",
  "dev:public": "KLIO_BUILD_TARGET=public next dev -p 3001",
  "build": "KLIO_BUILD_TARGET=${KLIO_BUILD_TARGET:-local} next build",
  "build:local": "KLIO_BUILD_TARGET=local next build",
  "build:public": "KLIO_BUILD_TARGET=public next build",
  "start": "next start",
  "lint": "next lint",
  "typecheck": "tsc --noEmit",
  "test:bundle-isolation": "node scripts/check-bundle-isolation.mjs"
}
```

**Step 2:** Confirm `npm run build:local` still succeeds (no exclusions yet, identical to old `next build`).

```bash
cd trust-app && npm run build:local 2>&1 | tail -5
```
Expected: `Compiled successfully` and a `.next/` directory with output.

**Step 3:** Same for public:

```bash
cd trust-app && npm run build:public 2>&1 | tail -5
```
Expected: identical success (no exclusions in effect).

**Step 4:** Commit.

```bash
git add trust-app/package.json
git commit -m "build(trust-app): add :local and :public script targets"
```

### Task A3: Add `next.config.js` shim with target validation

`trust-app/` does not currently have a `next.config.js` (Next.js 16 defaults are fine). We add one that:

1. Reads `KLIO_BUILD_TARGET` env var, defaults to `local`, errors loudly on unknown values.
2. (Future-) configures the webpack module rule. Empty rule for now — Section B fills it in.

**Files:**
- Create: `trust-app/next.config.js`

**Step 1:** Write the config file:

```js
// trust-app/next.config.js
//
// Build-target shim. Reads KLIO_BUILD_TARGET={local,public} and
// configures Next.js so that only the matching route group ships
// in the bundle. See docs/plans/2026-05-04-trust-app-build-targets-design.md.
//
// Section A (this commit) just establishes the env-var read + the
// "output: standalone" needed by the Dockerfile. Webpack exclusion
// rules land in Section B.

/** @type {string} */
const TARGET = process.env.KLIO_BUILD_TARGET || "local";

if (!["local", "public"].includes(TARGET)) {
  throw new Error(
    `KLIO_BUILD_TARGET must be 'local' or 'public'; got '${TARGET}'. ` +
      `Use npm run build:local or npm run build:public.`,
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: { typedRoutes: true },
};

console.log(`[next.config] KLIO_BUILD_TARGET=${TARGET}`);

module.exports = nextConfig;
```

**Step 2:** Run a build to confirm Next picks it up:

```bash
cd trust-app && npm run build:local 2>&1 | grep "KLIO_BUILD_TARGET"
```
Expected: `[next.config] KLIO_BUILD_TARGET=local`

**Step 3:** Try a bogus target — confirm the throw fires:

```bash
cd trust-app && KLIO_BUILD_TARGET=bogus npx next build 2>&1 | grep -E "must be|got 'bogus'"
```
Expected: the error message from `next.config.js`.

**Step 4:** Commit.

```bash
git add trust-app/next.config.js
git commit -m "build(trust-app): next.config.js reads KLIO_BUILD_TARGET"
```

---

## Section B — Route-group restructuring

Goal: relocate landing routes into `(public)/`, dashboard routes into `(local)/`, and add a target-aware `/` page that redirects to `/memories` in local mode.

### Task B1: Rename `(app)` → `(local)` route group

**Files:**
- Move: `trust-app/src/app/(app)/` → `trust-app/src/app/(local)/` (and all contents)

**Step 1:** Move the directory:

```bash
cd /Users/thakurg/Me/klio/trust-app/src/app
git mv "(app)" "(local)"
```

**Step 2:** Verify the layout file path is now `(local)/layout.tsx`:

```bash
ls "(local)/" | head
```
Expected: `access-requests`, `layout.tsx`, `memories`, `spaces`.

**Step 3:** Run typecheck:

```bash
cd /Users/thakurg/Me/klio/trust-app && npm run typecheck 2>&1 | tail -5
```
Expected: no errors. Route groups are filename-only conventions; route paths don't change.

**Step 4:** Run a build:

```bash
npm run build:local 2>&1 | tail -5
```
Expected: success.

**Step 5:** Commit.

```bash
cd /Users/thakurg/Me/klio
git add -A trust-app/src/app/
git commit -m "refactor(trust-app): rename (app) route group to (local)"
```

### Task B2: Create `(public)` route group, move landing files into it

**Files:**
- Move: `trust-app/src/app/page.tsx` → `trust-app/src/app/(public)/page.tsx`
- Move: `trust-app/src/app/security/` → `trust-app/src/app/(public)/security/`
- Move: `trust-app/src/app/verify/` → `trust-app/src/app/(public)/verify/`
- Verify (read first): are `security` and `verify` public or auth-required? If auth-required, leave them under `(local)/`.

**Step 1:** Inspect to decide:

```bash
cd /Users/thakurg/Me/klio/trust-app
grep -rn "requireSession\|getSession\|redirect" src/app/security/ src/app/verify/ 2>&1 | head
```
- If `requireSession()` or `redirect("/")` appears → that route is auth-required and stays under `(local)/`.
- Otherwise (publicly viewable, no auth gate) → move to `(public)/`.

**Step 2:** Move the public-only files:

```bash
mkdir -p src/app/\(public\)
git mv src/app/page.tsx src/app/\(public\)/page.tsx
# Move security and verify based on the inspection in Step 1.
# Example IF security is public:
# git mv src/app/security src/app/\(public\)/security
```

**Step 3:** Run typecheck:

```bash
npm run typecheck 2>&1 | tail -5
```
Expected: no errors. The `<HumanView>`/`<MachineView>` imports may need a relative-path bump — fix any that surface.

**Step 4:** Build:

```bash
npm run build:public 2>&1 | tail -5
```
Expected: success.

**Step 5:** Commit.

```bash
cd /Users/thakurg/Me/klio
git add -A trust-app/src/app/
git commit -m "refactor(trust-app): move landing routes into (public) group"
```

### Task B3: Add `(local)/page.tsx` that redirects `/` → `/memories`

When `KLIO_BUILD_TARGET=local`, the `(public)/` group is excluded (Section C handles the exclusion); without a `(local)/page.tsx`, the route `/` would 404. Add it.

**Files:**
- Create: `trust-app/src/app/(local)/page.tsx`

**Step 1:** Write the redirect:

```tsx
// trust-app/src/app/(local)/page.tsx
//
// Local-mode root: a user who pulls the trust-app via
// `npx @klio-tech/klio init` and opens http://127.0.0.1:3000
// expects to see their memories, not marketing copy. Redirect to
// the dashboard's home view. This file is included only when
// KLIO_BUILD_TARGET=local; the public build excludes the (local)/
// group entirely (see next.config.js).

import { redirect } from "next/navigation";

export default function Home() {
  redirect("/memories");
}
```

**Step 2:** Build local + public — both should succeed and have a `/` route resolved differently:

```bash
cd /Users/thakurg/Me/klio/trust-app && npm run build:local 2>&1 | grep "Route\|/memories"
```
Expected: the build output mentions `/` (the redirect) and `/memories`. (Section C will make this exclusive — for now both `(local)/page.tsx` and `(public)/page.tsx` exist and Next.js picks one based on alphabetical conflict resolution; this is fine because Section C is the next task.)

**Step 3:** Commit.

```bash
cd /Users/thakurg/Me/klio
git add trust-app/src/app/\(local\)/page.tsx
git commit -m "feat(trust-app): local-mode / redirects to /memories"
```

---

## Section C — Build-time exclusion via webpack

Goal: turn the route-group naming convention into actual bundle-level exclusion. After this section, a local build's `.next/` contains zero references to `(public)` modules, and vice versa.

### Task C1: Webpack rule in `next.config.js`

**Files:**
- Modify: `trust-app/next.config.js`

**Step 1:** Replace the placeholder `nextConfig` with the exclusion-aware version:

```js
// trust-app/next.config.js — full content after this task

const TARGET = process.env.KLIO_BUILD_TARGET || "local";

if (!["local", "public"].includes(TARGET)) {
  throw new Error(
    `KLIO_BUILD_TARGET must be 'local' or 'public'; got '${TARGET}'.`,
  );
}

// Path fragment that identifies the route group we want to EXCLUDE
// from the current build. Note the parens are escaped per-OS in the
// regex below.
const excludeGroup = TARGET === "local" ? "public" : "local";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: { typedRoutes: true },
  webpack: (config, { isServer }) => {
    // Replace any module whose absolute path matches `(<excludeGroup>)`
    // with `ignore-loader`, which emits an empty module. This stops
    // the unwanted route group from contributing any code to the
    // final bundle. Build fails LOUDLY if a shared component
    // accidentally imports something from the excluded group, which
    // is the safety net we want.
    //
    // Match `(public)` (or `(local)`) as a path segment so we don't
    // accidentally match arbitrary `public` substrings elsewhere.
    config.module.rules.unshift({
      test: new RegExp(`[\\\\/]\\(${excludeGroup}\\)[\\\\/]`),
      loader: "ignore-loader",
    });
    return config;
  },
};

console.log(`[next.config] KLIO_BUILD_TARGET=${TARGET} (excluding (${excludeGroup}))`);

module.exports = nextConfig;
```

**Step 2:** Build local + public, confirm both succeed:

```bash
cd /Users/thakurg/Me/klio/trust-app
rm -rf .next
npm run build:local 2>&1 | tail -5
echo "---"
rm -rf .next
npm run build:public 2>&1 | tail -5
```
Expected: both succeed.

**Step 3:** Sanity check — local build's `.next` should NOT contain landing component names:

```bash
rm -rf .next && npm run build:local
grep -rl "MachineView\|HumanView" .next/standalone/ 2>&1 | head
```
Expected: no matches (or: only inside source-map files which we'll ignore in Task C2's grep). If the only matches are `.next/types/` or `.next/cache/` non-runtime files, also acceptable.

**Step 4:** Commit.

```bash
cd /Users/thakurg/Me/klio
git add trust-app/next.config.js
git commit -m "build(trust-app): webpack rule excludes the unwanted route group"
```

### Task C2: Bundle-isolation guardrail script + npm test target

This is the belt-and-suspenders: even if a sloppy import slips through the route-group filter, this script catches the bytes and fails CI.

**Files:**
- Create: `trust-app/scripts/check-bundle-isolation.mjs`
- Modify: `trust-app/package.json` (the `test:bundle-isolation` script entry from Task A2 already exists)

**Step 1:** Write the script:

```js
// trust-app/scripts/check-bundle-isolation.mjs
//
// Belt-and-suspenders for the route-group exclusion in next.config.js.
// After a build, recursively grep the .next/standalone runtime output
// for substrings that should never appear in the wrong target. Fail
// loudly if any do — that's a leaked import the webpack rule didn't
// catch.
//
// Usage:
//   KLIO_BUILD_TARGET=local  npm run build:local && npm run test:bundle-isolation
//   KLIO_BUILD_TARGET=public npm run build:public && npm run test:bundle-isolation
//
// We grep the *runtime* bundle (.next/standalone/.next/server/) and
// the static client bundle (.next/standalone/.next/static/) — not
// .next/types/ (TypeScript dev artifacts), not .next/cache/.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TARGET = process.env.KLIO_BUILD_TARGET || "local";
if (!["local", "public"].includes(TARGET)) {
  console.error(`KLIO_BUILD_TARGET must be 'local' or 'public'; got '${TARGET}'`);
  process.exit(2);
}

// Strings that must NOT appear in each target's runtime bundle. If a
// future feature legitimately needs one of these strings in both
// targets (rare), update this list and document why.
const FORBIDDEN = {
  // Local builds must not contain landing-only artefacts
  local: ["MachineView", "HumanView", "ViewToggle", "(public)"],
  // Public builds must not contain dashboard / local-only artefacts
  public: [
    "KLIO_LOCAL_USER_ID",
    "getLocalDevSession",
    "(local)",
    // The dashboard's authenticated paths
    "/memories",
    "/spaces",
    "/access-requests",
  ],
};

const ROOT = join(process.cwd(), ".next", "standalone");
const SCAN_DIRS = [
  join(ROOT, ".next", "server"),
  join(ROOT, ".next", "static"),
];

/**
 * Walk a directory recursively yielding absolute file paths.
 * Skip source-map files (`.map`) — they're for debugging only and
 * naturally contain raw source identifiers that aren't shipped at
 * runtime.
 */
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (st.isFile() && !full.endsWith(".map")) {
      yield full;
    }
  }
}

const forbidden = FORBIDDEN[TARGET];
const violations = [];

for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    let body;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue; // binary / unreadable — skip
    }
    for (const needle of forbidden) {
      if (body.includes(needle)) {
        violations.push({ file, needle });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `\nBundle isolation FAILED for target=${TARGET}. ` +
      `Found ${violations.length} forbidden string occurrence(s):\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.needle}  →  ${v.file.replace(process.cwd(), ".")}`);
  }
  console.error(
    `\nThis means a module from the excluded route group leaked into the bundle.\n` +
      `Check the import graph of any shared file — most leaks are caused by\n` +
      `shared components reaching back into route-group internals.\n`,
  );
  process.exit(1);
}

console.log(
  `\n✓ Bundle isolation OK for target=${TARGET} ` +
    `(checked ${SCAN_DIRS.length} directory tree(s) for ${forbidden.length} forbidden strings)\n`,
);
```

**Step 2:** Run the test against the local build:

```bash
cd /Users/thakurg/Me/klio/trust-app
rm -rf .next && KLIO_BUILD_TARGET=local npm run build:local
KLIO_BUILD_TARGET=local npm run test:bundle-isolation
```
Expected: `✓ Bundle isolation OK for target=local`. If it fails, look at the violation list — usually a shared component imported a route-group-specific helper.

**Step 3:** Same for public:

```bash
cd /Users/thakurg/Me/klio/trust-app
rm -rf .next && KLIO_BUILD_TARGET=public npm run build:public
KLIO_BUILD_TARGET=public npm run test:bundle-isolation
```
Expected: `✓ Bundle isolation OK for target=public`.

**Step 4:** Commit.

```bash
cd /Users/thakurg/Me/klio
git add trust-app/scripts/check-bundle-isolation.mjs
git commit -m "test(trust-app): bundle-isolation guardrail for build targets"
```

---

## Section D — Docker

### Task D1: Add `KLIO_BUILD_TARGET` arg to Dockerfile

**Files:**
- Modify: `trust-app/Dockerfile`

**Step 1:** Add the build arg + thread it through the build stage. Read current Dockerfile first:

```bash
cat /Users/thakurg/Me/klio/trust-app/Dockerfile
```

Then patch the `build` stage (around the `RUN npm run build` line) to:

```dockerfile
# Stage 2 (build)
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build target — `local` (npm-launched user dashboard) or `public`
# (klio.tech marketing site). Both share this Dockerfile; the
# matching route group ships in each image.
ARG KLIO_BUILD_TARGET=local
ENV KLIO_BUILD_TARGET=${KLIO_BUILD_TARGET}

RUN npm run build
RUN npm run test:bundle-isolation
```

The `npm run build` script already reads `KLIO_BUILD_TARGET` from env (Task A2). The bundle-isolation test runs as the LAST step of the build stage so an image that would leak forbidden strings simply doesn't build at all — CI fails before any push.

**Step 2:** Build local image:

```bash
cd /Users/thakurg/Me/klio
docker build --build-arg KLIO_BUILD_TARGET=local -t klio-trust-app:local-test ./trust-app 2>&1 | tail -10
```
Expected: success, ends with bundle-isolation `✓` line.

**Step 3:** Build public image:

```bash
docker build --build-arg KLIO_BUILD_TARGET=public -t klio-trust-app:public-test ./trust-app 2>&1 | tail -10
```
Expected: success.

**Step 4:** Smoke run the local image and curl `/`:

```bash
docker run -d --name klio-trust-app-test -p 3001:3000 \
  -e KLIO_LOCAL_DEV=1 \
  -e KLIO_LOCAL_USER_ID=00000000-0000-0000-0000-000000000000 \
  -e KLIO_LOCAL_AGENT_ID=00000000-0000-0000-0000-000000000000 \
  -e KLIO_JWT_SIGNING_KEY=test \
  -e KLIO_ENGINE_URL=http://127.0.0.1:8000 \
  klio-trust-app:local-test
sleep 3
curl -sI http://127.0.0.1:3001/ | head -1
docker rm -f klio-trust-app-test
```
Expected: `HTTP/1.1 307 Temporary Redirect` (the `/` → `/memories` redirect). If it shows 200 with HTML, something's wrong with route-group exclusion.

**Step 5:** Same smoke for public:

```bash
docker run -d --name klio-trust-app-test -p 3001:3000 klio-trust-app:public-test
sleep 3
curl -sI http://127.0.0.1:3001/ | head -1
curl -s http://127.0.0.1:3001/ | grep -E "klio|memory" | head -1
docker rm -f klio-trust-app-test
```
Expected: `HTTP/1.1 200 OK` and the response body mentions `klio` (landing copy).

**Step 6:** Commit.

```bash
cd /Users/thakurg/Me/klio
git add trust-app/Dockerfile
git commit -m "build(trust-app): KLIO_BUILD_TARGET arg threads through Dockerfile"
```

---

## Section E — CI: build + push two images

### Task E1: Add `klio-landing` to `release-images.yml` matrix

**Files:**
- Modify: `.github/workflows/release-images.yml`

**Step 1:** Read current workflow:

```bash
cat /Users/thakurg/Me/klio/.github/workflows/release-images.yml
```

**Step 2:** Add a new matrix entry for `klio-landing` and add `build_args` to the existing `klio-trust-app` entry. Result:

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - name: klio-engine
        context: ./engine
      - name: klio-bridge
        context: ./bridge
      - name: klio-trust-app
        context: ./trust-app
        build_args: |
          KLIO_BUILD_TARGET=local
      - name: klio-landing
        context: ./trust-app
        build_args: |
          KLIO_BUILD_TARGET=public
```

Then in the `Build and push` step, pass `build-args` through to `docker/build-push-action`:

```yaml
- name: Build and push ${{ matrix.name }}
  uses: docker/build-push-action@v6
  with:
    context: ${{ matrix.context }}
    file: ${{ matrix.context }}/Dockerfile
    platforms: linux/amd64,linux/arm64
    push: true
    tags: ${{ steps.meta.outputs.tags }}
    labels: ${{ steps.meta.outputs.labels }}
    build-args: ${{ matrix.build_args }}
    cache-from: type=gha,scope=${{ matrix.name }}
    cache-to: type=gha,mode=max,scope=${{ matrix.name }}
    provenance: false
```

**Step 3:** Validate the YAML locally:

```bash
cd /Users/thakurg/Me/klio
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release-images.yml'))" && echo "yaml-ok"
```
Expected: `yaml-ok`.

**Step 4:** Commit.

```bash
git add .github/workflows/release-images.yml
git commit -m "ci(images): add klio-landing target alongside klio-trust-app"
```

---

## Section F — npm package (no functional change, just version + comment refresh)

The npm package's `compose.ts` already references `klio-trust-app` — that reference is the LOCAL build now. No code change. We just bump the version and refresh comments.

### Task F1: Bump npm to 0.4.0

**Files:**
- Modify: `npm/package.json` (version)
- Modify: `npm/src/compose.ts` (one comment line, optional)
- Modify: `npm/src/commands/init.ts` (narrate text, optional)

**Step 1:** Bump:

```bash
cd /Users/thakurg/Me/klio/npm
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); p.version='0.4.0'; fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n')"
npm install --package-lock-only --no-audit --no-fund
```

**Step 2:** Refresh `narrate` text in init.ts to reflect the local-only dashboard reality. Find:

```
"The dashboard runs at http://127.0.0.1:3000 — your timeline of every memory, redaction, and audit event."
```

(Already accurate — local build now lands directly on `/memories`. May not need a change. Verify by reading the current line.)

**Step 3:** Test build:

```bash
cd /Users/thakurg/Me/klio/npm && npm run build && npm test
```
Expected: build clean, all 168 (or current count) tests pass. No regressions — none of the npm package code changed structurally.

**Step 4:** Commit.

```bash
cd /Users/thakurg/Me/klio
git add npm/package.json npm/package-lock.json
git commit -m "chore(npm): release 0.4.0 — trust-app build-target split"
```

---

## Section G — Manual verification + ship

### Task G1: Local end-to-end smoke

**Goal:** prove the new local image lands on `/memories` directly when invoked from the user-facing flow.

**Step 1:** Wipe prior state:

```bash
cd /Users/thakurg/Me/klio
docker compose -f ~/.klio/docker-compose.yml down -v 2>/dev/null
rm -rf ~/.klio/docker-compose.yml ~/.klio/.env ~/.klio/install.json
```

**Step 2:** Tag the local-test image as the GHCR name so the npm flow uses our just-built image instead of pulling:

```bash
docker tag klio-trust-app:local-test ghcr.io/klio-tech/klio-trust-app:0.4.0
```

**Step 3:** Build the npm package + run init from a fresh dir:

```bash
cd /Users/thakurg/Me/klio/npm
npm run build && npm pack
mv klio-tech-klio-0.4.0.tgz /tmp/
cd /tmp && npx /tmp/klio-tech-klio-0.4.0.tgz init
```

**Step 4:** When init finishes, hit the dashboard:

```bash
curl -sIL http://127.0.0.1:3000/ | head -5
```
Expected:
```
HTTP/1.1 307 Temporary Redirect
Location: /memories
HTTP/1.1 200 OK
```
The `307 → /memories → 200 OK` chain proves local mode redirects correctly.

**Step 5:** Open Cowork or Claude Code, ask `recall what I'm doing` — confirm klio MCP tools still work (no regression in the dashboard split).

### Task G2: Public-image verification (klio.tech parity)

**Goal:** confirm the new public image renders klio.tech's content identically to today's deploy.

**Step 1:** Run the public image:

```bash
docker run -d --name klio-landing-test -p 3001:3000 klio-trust-app:public-test
sleep 3
```

**Step 2:** Compare key pages:

```bash
curl -s http://127.0.0.1:3001/?view=human | grep -E "klio|persistent memory" | head
curl -s http://127.0.0.1:3001/?view=machine | grep -E "name:.*Klio" | head
```
Expected: both view modes render. The HumanView/MachineView toggle works.

**Step 3:** Cleanup:

```bash
docker rm -f klio-landing-test
```

### Task G3: Push (only after user approval)

When user explicitly approves:

```bash
cd /Users/thakurg/Me/klio
git push origin feat/trust-app-build-targets
# then merge to main:
git checkout main
git merge --ff-only feat/trust-app-build-targets
git push
```

CI:
1. Builds + pushes `ghcr.io/klio-tech/klio-trust-app:0.4.0` (LOCAL build, what npm pulls)
2. Builds + pushes `ghcr.io/klio-tech/klio-landing:0.4.0` (PUBLIC build, for Railway)
3. Publishes `@klio-tech/klio@0.4.0` to npm
4. Bundle-isolation test runs inside each image build; CI fails if any leaks.

### Task G4: Switch Railway to pull `klio-landing`

**Manual step on Railway:**
1. Open the trust-app deployment.
2. Change the image source from `ghcr.io/klio-tech/klio-trust-app` to `ghcr.io/klio-tech/klio-landing`.
3. Pin to `:0.4.0` (or use `:latest`).
4. Trigger a deploy.
5. Verify `klio.tech` renders identically to before.

Until this step lands, klio.tech keeps serving the 0.3.x trust-app image (which still has the landing routes — they were always there). After the swap, klio.tech serves the dedicated landing image.

---

## Closing notes

- **Tests:** `npm run test:bundle-isolation` runs after every build (in the Dockerfile + locally). 168+ existing npm tests must still pass.
- **Coverage target:** zero forbidden-string occurrences in either target's runtime bundle.
- **Rollback path:** if `0.4.0` breaks anything, point the npm package at `klio-trust-app:0.3.6` and Railway at the same. The 0.3.x line stays on GHCR.
- **Skill follow-up:** for execution, use `superpowers:subagent-driven-development` (same-session, fresh subagent per task with two-stage review) or `superpowers:executing-plans` (separate session, batched).

**Branch policy:** Hold local. Do not push the implementation branch or any of the new image tags until the user explicitly approves.
