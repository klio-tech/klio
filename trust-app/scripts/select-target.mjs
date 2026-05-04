// trust-app/scripts/select-target.mjs
//
// Pre-build step that hides the unwanted route group from Next.js's
// FS router by renaming it to a private folder name. Next treats any
// folder whose name starts with `_` as private and never resolves it
// as a route, so this is a clean way to exclude a route group from
// a build without touching webpack/Turbopack internals.
//
// Why this exists:
//   `(local)/page.tsx` and `(public)/page.tsx` both resolve to the
//   `/` route, so the build errors with "two parallel pages" unless
//   one of them is removed at FS-resolution time. Next 16 uses
//   Turbopack by default and ignores `webpack:` config, so the
//   ignore-loader trick from earlier sections doesn't fire. Renaming
//   is bundler-agnostic and works with both Turbopack and webpack.
//
// Contract:
//   node scripts/select-target.mjs <local|public>
//
//     Hides the OPPOSITE group. Idempotent: running twice with the
//     same target is a no-op. Always restores any previously-hidden
//     directory belonging to the chosen target before hiding the
//     opposite one, so toggling between targets works without an
//     explicit restore step in between.
//
// Pair this with scripts/restore-targets.mjs, which unconditionally
// reverses any rename. The npm build scripts invoke restore in both
// the success and failure paths so the working tree is never left
// in a hidden state.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { moveDir } from "./move-dir.mjs";

const APP_DIR = join(process.cwd(), "src", "app");

/** Group name -> visible / hidden directory names. */
const GROUPS = {
  local: {
    visible: join(APP_DIR, "(local)"),
    hidden: join(APP_DIR, "__klio_hidden_local__"),
  },
  public: {
    visible: join(APP_DIR, "(public)"),
    hidden: join(APP_DIR, "__klio_hidden_public__"),
  },
};

/**
 * Make a group VISIBLE to the FS router (un-hide it). No-op if it's
 * already visible. Errors if neither name exists — that means the
 * group was deleted entirely, which is a bigger problem than this
 * script can fix.
 */
function show(group) {
  const { visible, hidden } = GROUPS[group];
  if (existsSync(visible)) return;
  if (existsSync(hidden)) {
    moveDir(hidden, visible);
    return;
  }
  throw new Error(
    `Route group (${group}) not found at ${visible} or ${hidden}. ` +
      `The directory may have been deleted — check your working tree.`,
  );
}

/**
 * Hide a group from the FS router. No-op if already hidden.
 */
function hide(group) {
  const { visible, hidden } = GROUPS[group];
  if (existsSync(hidden)) return;
  if (!existsSync(visible)) {
    throw new Error(
      `Cannot hide route group (${group}): neither ${visible} nor ${hidden} exists.`,
    );
  }
  moveDir(visible, hidden);
}

function main() {
  const target = process.argv[2];
  if (!target || !["local", "public"].includes(target)) {
    console.error(
      `Usage: node scripts/select-target.mjs <local|public>\n` +
        `Got: ${target ?? "(nothing)"}`,
    );
    process.exit(2);
  }

  const exclude = target === "local" ? "public" : "local";

  // Always restore the desired target first (so that toggling
  // between targets works without an explicit restore in between).
  show(target);
  // Then hide the unwanted one.
  hide(exclude);

  console.log(
    `[select-target] target=${target} → showing (${target}), ` +
      `hiding (${exclude}) as __klio_hidden_${exclude}__`,
  );
}

main();
