// Flag parsing for `klio init`.
//
// The parser is hand-rolled (zero runtime dependencies is a constraint of
// this package), so the value-consuming flags — `--key`, `--email`,
// `--image-tag`, `--engine-url` — are where an off-by-one would silently
// swallow the following flag as its value. `--key` matters most: it carries
// a live credential, and a parser that ate `--cloud` as the key would send
// the literal string "--cloud" to /verify and report an invalid key.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseInitArgs } from "../src/initArgs.js";

/** Run the parser with KLIO_API_KEY controlled, then restore it. */
function withEnvKey<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.KLIO_API_KEY;
  if (value === undefined) delete process.env.KLIO_API_KEY;
  else process.env.KLIO_API_KEY = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KLIO_API_KEY;
    else process.env.KLIO_API_KEY = prev;
  }
}

test("--key captures the following argument", () => {
  const opts = withEnvKey(undefined, () =>
    parseInitArgs(["--cloud", "--key", "sk-abc-123"]),
  );

  assert.equal(opts.apiKey, "sk-abc-123");
  assert.equal(opts.mode, "cloud");
});

test("--key does not swallow the flag that follows it", () => {
  const opts = withEnvKey(undefined, () =>
    parseInitArgs(["--key", "sk-abc-123", "--cloud", "--quiet"]),
  );

  assert.equal(opts.apiKey, "sk-abc-123");
  assert.equal(opts.mode, "cloud");
  assert.equal(opts.quiet, true);
});

test("KLIO_API_KEY supplies the key when --key is absent", () => {
  const opts = withEnvKey("sk-from-env-999", () => parseInitArgs(["--cloud"]));

  assert.equal(opts.apiKey, "sk-from-env-999");
});

test("--key overrides KLIO_API_KEY", () => {
  const opts = withEnvKey("sk-from-env-999", () =>
    parseInitArgs(["--cloud", "--key", "sk-from-flag-111"]),
  );

  assert.equal(opts.apiKey, "sk-from-flag-111");
});

test("no key anywhere leaves apiKey undefined so the prompt still runs", () => {
  const opts = withEnvKey(undefined, () => parseInitArgs(["--cloud"]));

  assert.equal(opts.apiKey, undefined);
});
