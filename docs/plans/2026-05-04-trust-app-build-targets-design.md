# trust-app build targets — design

**Date:** 2026-05-04
**Status:** Approved, ready for implementation plan
**Target release:** `0.4.0` (breaking change: GHCR image renamed)

## Why this exists

Today the `trust-app` Next.js app is a single bundle that ships everything:
the public marketing landing (HumanView/MachineView toggle), the verify
flow, AND the authenticated local dashboard (memories, spaces,
access-requests). One bundle gets pulled by `npx @klio-tech/klio init`
into the user's local container. Two consequences are wrong:

1. **The local user lands on marketing copy.** Hitting
   `http://127.0.0.1:3000` after install renders `/` — the public
   landing. To get to their memories the user has to know to navigate
   to `/memories`. That's the bug surfaced in the 2026-05-04 Cowork
   debugging thread.
2. **The local image carries unused weight.** Every byte of landing
   copy, hero animation, and public-only library code rides into every
   user's `~/.klio/` install. ~150–200 KB compressed.

## Goal

Split the trust-app into two build targets driven by an env var, both
served from the same source tree:

| Target | Env var | Routes shipped | Image | Deploys to |
|---|---|---|---|---|
| **`public`** | `KLIO_BUILD_TARGET=public` | landing routes only (HumanView/MachineView, security policy, verify flow if public) | `ghcr.io/klio-tech/klio-landing:<version>` | Railway → `klio.tech` |
| **`local`** | `KLIO_BUILD_TARGET=local` | dashboard routes only (`/memories`, `/spaces`, `/access-requests`) + a `/` redirect to `/memories` | `ghcr.io/klio-tech/klio-trust-app:<version>` (rename or keep) | npm-launched local stack |

Both targets share the same `src/` tree, the same brand components, the
same design tokens, and the same `next.config.js`. The only thing that
varies is which **route group** is included at build time.

## Non-goals

- Klio Cloud (paid, multi-tenant, cross-device sync). Different repo,
  different codebase. Out of scope for this design.
- Preserving the existing `klio-trust-app` image name as a public-facing
  artifact. After this lands, that image is the LOCAL build only;
  the public landing gets its own `klio-landing` image. Existing pulls
  of `klio-trust-app` will continue to work because the published
  image at the previous version stays on GHCR.
- Refactoring shared components. The HumanView/MachineView, dashboard
  primitives, KlioMark, etc. all stay where they are; the route groups
  decide which **routes** ship.

## Architecture

### Route grouping

```
trust-app/src/app/
├── layout.tsx                  ← shared root layout
├── globals.css                 ← shared design tokens (kept)
├── icon.tsx                    ← favicon (kept)
├── page.tsx                    ← target-specific entrypoint (see below)
├── (public)/                   ← shipped only when KLIO_BUILD_TARGET=public
│   ├── security/
│   ├── verify/
│   └── (page.tsx implementation moves here)
└── (local)/                    ← shipped only when KLIO_BUILD_TARGET=local
    ├── memories/
    ├── spaces/
    ├── access-requests/
    └── layout.tsx              ← auth-required layout (currently in (app)/)
```

The existing `(app)/` route group gets renamed `(local)/` to make
intent explicit. Same files, same code — just lives under a name that
makes the build-time exclusion obvious.

### Build-time exclusion mechanism

Next.js doesn't natively support per-build-target route inclusion, so
we use a tiny `next.config.js` shim that rewrites `pageExtensions` and
prunes the unwanted route group via webpack:

```js
// trust-app/next.config.js
const TARGET = process.env.KLIO_BUILD_TARGET || "local";
if (!["public", "local"].includes(TARGET)) {
  throw new Error(
    `KLIO_BUILD_TARGET must be 'public' or 'local'; got ${TARGET}`,
  );
}

const exclude =
  TARGET === "public"
    ? /\(local\)/
    : /\(public\)/;

module.exports = {
  output: "standalone",
  experimental: { typedRoutes: true },
  webpack: (config) => {
    // Replace the unwanted route group's modules with a stub that
    // throws at construction. Build fails LOUDLY if a shared component
    // accidentally imports something from the excluded group, which
    // is the safety net we want.
    config.module.rules.unshift({
      test: exclude,
      loader: "ignore-loader",
    });
    return config;
  },
};
```

`ignore-loader` is a 30-line npm package that tells webpack to emit
nothing for matched files. It's a real package, but it's tiny and
maintained — acceptable runtime dep on the BUILD side (not shipped
in the runtime bundle).

### `page.tsx` per-target entrypoint

```tsx
// trust-app/src/app/page.tsx
import { redirect } from "next/navigation";
const TARGET = process.env.KLIO_BUILD_TARGET || "local";

export default function Home() {
  if (TARGET === "local") {
    redirect("/memories");
  }
  // Public build: lazy-load the landing page from (public)/index
  // so the local build doesn't have to webpack the landing imports.
  const Landing = require("./(public)/landing").default;
  return <Landing />;
}
```

The build-time exclusion stops the `(public)/landing` module from
being resolved when target=local — the `require` call statically
depends on a path that webpack rewrites to ignore-loader, which
returns an empty module. The runtime `if (TARGET === "local")` short-
circuits before that branch is ever taken in local mode anyway.

(Cleaner alternative: have **two** `page.tsx` files, one per route
group, and let Next.js's app router handle the selection. We'll
prototype both during implementation and pick whichever produces
the simpler dist.)

### Package scripts

```json
{
  "scripts": {
    "build": "KLIO_BUILD_TARGET=${KLIO_BUILD_TARGET:-local} next build",
    "build:local": "KLIO_BUILD_TARGET=local next build",
    "build:public": "KLIO_BUILD_TARGET=public next build",
    "dev": "KLIO_BUILD_TARGET=${KLIO_BUILD_TARGET:-local} next dev",
    "dev:local": "KLIO_BUILD_TARGET=local next dev",
    "dev:public": "KLIO_BUILD_TARGET=public next dev",
    "test:bundle-isolation": "node scripts/check-bundle-isolation.mjs"
  }
}
```

`test:bundle-isolation` is a guardrail script that runs **after each
build** and `grep`s the generated `.next/` output for tokens that
should never appear in the wrong target. Examples:

- A local build must not contain the strings `MachineView`,
  `HumanView`, or `klio.tech/security`.
- A public build must not contain the strings
  `KLIO_LOCAL_USER_ID`, `getLocalDevSession`, or any reference to
  `/memories`.

Belt-and-suspenders: if a sloppy import slips through the route-group
filter, this script fails the CI build.

### Docker

Two Dockerfiles, or one Dockerfile with a build-arg:

```dockerfile
# trust-app/Dockerfile
ARG KLIO_BUILD_TARGET=local
ENV KLIO_BUILD_TARGET=${KLIO_BUILD_TARGET}
RUN npm run build  # picks target from env
```

The CI workflow becomes a 2x matrix (target × architecture) of the
existing single matrix.

### CI workflow changes

`.github/workflows/release-images.yml`:

```yaml
matrix:
  include:
    - name: klio-engine
      context: ./engine
    - name: klio-bridge
      context: ./bridge
    - name: klio-trust-app
      context: ./trust-app
      build_args: KLIO_BUILD_TARGET=local
    - name: klio-landing               # NEW
      context: ./trust-app             # SAME source tree
      build_args: KLIO_BUILD_TARGET=public
```

Both images get tagged with the same version derived from
`npm/package.json`. The npm package's compose template continues to
reference `klio-trust-app` (the local build); Railway gets pointed at
`klio-landing` (the public build).

### npm compose template

`npm/src/compose.ts` already references `ghcr.io/klio-tech/klio-trust-app:${tag}`. After this change, that reference points at the **local** build (which is what we want). No change needed.

The narrate text in `init.ts` ("The dashboard runs at
http://127.0.0.1:3000 — your timeline of every memory, redaction, and
audit event.") becomes accurate again — the user really is landing on
the dashboard, not on marketing.

### Railway deploy

Railway is currently pulling `klio-trust-app` for klio.tech. After
this change, it pulls `klio-landing`. One env-var change in Railway
(`KLIO_BUILD_TARGET=public` is no longer needed at runtime — it was
already baked at build time — but the image name changes).

## Migration order

To avoid klio.tech going dark during the cutover:

1. **Land the build-target plumbing in this repo.** Both `klio-trust-app:next` and `klio-landing:next` images get pushed to GHCR. Existing users of `klio-trust-app:0.3.6` continue to work; nothing breaks.
2. **Verify both images locally.** Pull `klio-landing:next`, run it, hit `klio.tech`-style URLs — confirm parity with current Railway deploy.
3. **Switch Railway to pull `klio-landing:0.4.0`.** Brief deploy. Verify klio.tech still serves correctly.
4. **Bump npm package to 0.4.0.** The new local trust-app (with route-group exclusion + `/` redirect) ships in the GHCR image tagged `klio-trust-app:0.4.0`. `npx @klio-tech/klio@0.4.0 init` users now land directly on `/memories`.

Old klio.tech URLs (`/security`, `/verify`) keep working from step 3
onward because the public build includes them.

## Tradeoffs

| | Pro | Con |
|---|---|---|
| Same repo, two targets | One source of truth, brand components shared without a separate package, single CI workflow with a matrix expansion | Build matrix doubles CI time (~6→8 min), one extra ignore-loader build dep |
| vs. separate landing repo | Lower coordination cost — landing changes ride with this repo's git history | Marketing iteration speed is locked to this repo's release cadence |
| vs. runtime feature flags | Build-time exclusion = local image physically does not contain landing assets, can't accidentally serve them | More mechanism (next.config.js shim + bundle-isolation test) |

## Tests

- `test:bundle-isolation` runs after each build, fails on cross-target leaks
- Existing `npm test` continues to run against both targets
- One smoke test per target: `curl http://127.0.0.1:3000/` returns the right content (memories redirect for local, landing for public)

## Risk register

- **Risk:** ignore-loader doesn't actually exclude all files matched by the regex (e.g., dynamic imports). **Mitigation:** the `test:bundle-isolation` grep catches anything that slipped through; CI fails the build.
- **Risk:** Existing klio.tech users hit a 5xx during the Railway image swap. **Mitigation:** zero-downtime swap is a Railway primitive; we deploy `:0.4.0` of `klio-landing` first and only point production at it after a manual verify.
- **Risk:** A future contributor adds a public-only feature inside `(local)` by mistake and the bundle-isolation grep doesn't catch it because the strings don't match. **Mitigation:** code review + the route-group naming convention is self-documenting.
- **Risk:** Brand drift between targets if shared components get edited and only one target's CI runs. **Mitigation:** both targets build on every PR; if a shared component breaks, both fail.

## Open questions

- Whether to rename `(app)/` → `(local)/`. Argued for clarity; alternative is to keep `(app)/` and put public stuff in `(public)/`. Decision deferred to implementation; both work.
- Whether `/security` and `/verify` are public-only or shared. Need to read those files during implementation; if they reference `requireSession()` they're local-only and stay; otherwise they go to `(public)`.
- Whether to use `ignore-loader` or hand-roll the equivalent (~10 LOC). Decision: use `ignore-loader` for v0.4.0 — fastest path; revisit only if it breaks.
