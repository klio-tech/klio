#!/usr/bin/env node
// klio CLI entry point.
//
// We intentionally keep this file dead-simple — no logic, no
// side effects. The actual CLI lives in dist/cli.js, compiled from
// src/cli.ts at publish time. Two reasons:
//
//   1. Distinguishing the published shape (a single .mjs that
//      forwards to dist/cli.js) from the source layout makes
//      `npm pack`-style audits easy: any logic in this file would
//      need re-review per release; logic in src/cli.ts goes
//      through tsc.
//
//   2. The `bin` field in package.json must point to a file that
//      exists when npm installs the package (i.e. without a build
//      step on the user's machine). dist/ is shipped pre-built.

import("../dist/cli.js").catch((err) => {
  console.error("klio: failed to start —", err?.message ?? err);
  process.exit(1);
});
