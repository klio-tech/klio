// envFile parser + targeted-replace tests.
//
// `klio update curator` and `klio update provider` need to read the
// existing ~/.klio/.env, change a slice (just the curator block, or
// just the provider block), and write back without touching the
// rest. This file pins the parser shape + the merge contract.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseEnvFile,
  mergeEnvFile,
} from "../src/envFile.js";


function tmpEnv(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "klio-envtest-"));
  const path = join(dir, ".env");
  writeFileSync(path, content);
  return path;
}


test("parseEnvFile reads simple key=value lines", () => {
  const path = tmpEnv("KLIO_FOO=bar\nKLIO_BAZ=qux\n");
  const env = parseEnvFile(path);
  assert.equal(env.KLIO_FOO, "bar");
  assert.equal(env.KLIO_BAZ, "qux");
});


test("parseEnvFile ignores comments and blank lines", () => {
  const path = tmpEnv(
    "# top comment\nKLIO_A=1\n\n# another\nKLIO_B=2\n",
  );
  const env = parseEnvFile(path);
  assert.deepEqual(env, { KLIO_A: "1", KLIO_B: "2" });
});


test("parseEnvFile preserves the value verbatim (no quote stripping)", () => {
  // We don't enforce dotenv-style quoting because docker compose's
  // env interpolation accepts both `FOO=bar` and `FOO="bar"`. Pass
  // through whatever the user wrote.
  const path = tmpEnv('KLIO_X="quoted value"\nKLIO_Y=plain\n');
  const env = parseEnvFile(path);
  assert.equal(env.KLIO_X, '"quoted value"');
  assert.equal(env.KLIO_Y, "plain");
});


test("parseEnvFile returns empty object on missing file", () => {
  // Used in update flows where the file may not exist yet (rare —
  // klio init creates it — but we don't want to crash if it's gone).
  assert.deepEqual(parseEnvFile("/nonexistent/path/.env"), {});
});


test("mergeEnvFile replaces existing keys without touching others", () => {
  const path = tmpEnv("KLIO_A=1\nKLIO_B=2\nKLIO_C=3\n");
  mergeEnvFile(path, { KLIO_B: "updated" });
  const env = parseEnvFile(path);
  assert.deepEqual(env, { KLIO_A: "1", KLIO_B: "updated", KLIO_C: "3" });
});


test("mergeEnvFile adds new keys", () => {
  const path = tmpEnv("KLIO_A=1\n");
  mergeEnvFile(path, { KLIO_NEW: "value" });
  const env = parseEnvFile(path);
  assert.deepEqual(env, { KLIO_A: "1", KLIO_NEW: "value" });
});


test("mergeEnvFile creates the file if it doesn't exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "klio-mergetest-"));
  const path = join(dir, ".env");
  mergeEnvFile(path, { KLIO_A: "1" });
  const env = parseEnvFile(path);
  assert.deepEqual(env, { KLIO_A: "1" });
});
