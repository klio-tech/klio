// trust-app/scripts/restore-targets.mjs
//
// Unconditionally restore both route groups to their visible names.
// Safe to run any time, in any state — it just walks both groups and
// renames `__klio_hidden_<group>__` back to `(<group>)` if the
// hidden form exists.
//
// Invoked by the npm build scripts on BOTH success and failure
// paths so a failing build never leaves the working tree in a
// hidden state. Also useful to run manually if a build was killed
// (Ctrl-C) mid-flight.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { moveDir } from "./move-dir.mjs";

const APP_DIR = join(process.cwd(), "src", "app");

const GROUPS = ["local", "public"];

let restoredCount = 0;
for (const group of GROUPS) {
  const visible = join(APP_DIR, `(${group})`);
  const hidden = join(APP_DIR, `__klio_hidden_${group}__`);
  if (existsSync(hidden) && !existsSync(visible)) {
    moveDir(hidden, visible);
    restoredCount += 1;
    console.log(`[restore-targets] restored (${group})`);
  } else if (existsSync(hidden) && existsSync(visible)) {
    // Both exist — somebody created (group)/ manually while the
    // hidden form was around. Don't merge; leave the hidden form
    // alone but warn so the dev knows to clean up.
    console.warn(
      `[restore-targets] WARNING: both ${visible} and ${hidden} exist. ` +
        `Leaving ${hidden} in place. Resolve manually.`,
    );
  }
}

if (restoredCount === 0) {
  console.log(`[restore-targets] no hidden groups to restore`);
}
