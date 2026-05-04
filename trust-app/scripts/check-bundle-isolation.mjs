// trust-app/scripts/check-bundle-isolation.mjs
//
// Belt-and-suspenders for the route-group exclusion in
// scripts/select-target.mjs. After a build, recursively grep the
// .next/standalone runtime output for substrings that should never
// appear in the wrong target. Fail loudly if any do — that's a
// leaked import the FS-router exclusion didn't catch (e.g. a
// shared component reaching back into route-group internals).
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
  console.error(
    `KLIO_BUILD_TARGET must be 'local' or 'public'; got '${TARGET}'`,
  );
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

// Allowlist for legitimate cross-target string references. A
// violation is suppressed only if BOTH the needle matches AND the
// file path contains the given fragment. Keep entries narrow — the
// (file-fragment, needle) tuple acts like a fingerprint, so a future
// real leak from a different file will still trigger.
//
// Each entry MUST carry a `reason` that explains why the string is
// allowed. If the listed reason no longer applies, delete the entry
// rather than letting it rot.
const SHARED_LEGITIMATE = [
  {
    target: "public",
    needle: "/spaces",
    fileFragment: "chunks/ssr/",
    reason:
      "(public)/verify/page.tsx redirects to /spaces after the engine " +
      "issues a session cookie. The redirect target lives in the " +
      "(local) build; in a public-only deployment that doesn't host " +
      "the dashboard, the redirect lands on whatever runs at /spaces " +
      "(typically a local-mode app at the same origin or a 404). The " +
      "string is a URL literal, not an import of (local) code.",
  },
];

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
const allowlist = SHARED_LEGITIMATE.filter((e) => e.target === TARGET);

/**
 * Return true if the (file, needle) pair is in the allowlist.
 */
function isAllowed(file, needle) {
  return allowlist.some(
    (e) => e.needle === needle && file.includes(e.fileFragment),
  );
}

const violations = [];
const allowed = [];

for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    let body;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue; // binary / unreadable — skip
    }
    for (const needle of forbidden) {
      if (!body.includes(needle)) continue;
      if (isAllowed(file, needle)) {
        allowed.push({ file, needle });
      } else {
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
    console.error(`  ${v.needle}  ->  ${v.file.replace(process.cwd(), ".")}`);
  }
  console.error(
    `\nThis means a module from the excluded route group leaked into the bundle.\n` +
      `Check the import graph of any shared file - most leaks are caused by\n` +
      `shared components reaching back into route-group internals.\n`,
  );
  process.exit(1);
}

if (allowed.length > 0) {
  console.log(`\nAllowlisted occurrence(s) (legitimate cross-target):`);
  for (const a of allowed) {
    console.log(`  ${a.needle}  ->  ${a.file.replace(process.cwd(), ".")}`);
  }
}

console.log(
  `\nBundle isolation OK for target=${TARGET} ` +
    `(checked ${SCAN_DIRS.length} directory tree(s) for ${forbidden.length} forbidden strings, ` +
    `${allowed.length} allowlisted)\n`,
);
