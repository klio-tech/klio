// Resolve the package version at runtime by reading our own
// package.json. Avoids a build-time substitution step (which is
// brittle on a published package — sed across dist/ misses ESM
// edge cases like template literals).
//
// dist/version.js sits next to dist/cli.js after `tsc`; the
// published tarball includes both dist/ and package.json (see
// the "files" field). The relative path "../package.json" is
// stable.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, "..", "package.json");

let cached: string | null = null;

export function packageVersion(): string {
  if (cached) return cached;
  try {
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    cached = pkg.version ?? "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
