// Unit tests for cloud config persistence (src/cloudConfig.ts):
// the ~/.klio/config.json round-trip, secret-safe 0600 perms, and the
// tolerant read path (missing / malformed / keyless → null, never throw).

import { strict as assert } from "node:assert";
import * as fsModule from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CLOUD_BASE_URL } from "../src/cloud.js";
import {
  cloudConfigPath,
  readCloudConfig,
  writeCloudConfig,
  writeConfigObject,
} from "../src/cloudConfig.js";

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "klio-cfg-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("cloudConfigPath resolves under ~/.klio", () => {
  assert.equal(cloudConfigPath("/home/x"), "/home/x/.klio/config.json");
});

test("write then read round-trips the config", () => {
  withTmp((dir) => {
    const path = join(dir, "config.json");
    writeCloudConfig(
      { apiKey: "ag_live_abc", agentId: "klio-host", baseUrl: CLOUD_BASE_URL },
      path,
    );
    const cfg = readCloudConfig(path);
    assert.deepEqual(cfg, {
      apiKey: "ag_live_abc",
      agentId: "klio-host",
      baseUrl: CLOUD_BASE_URL,
    });
  });
});

test("written secret file is 0600", () => {
  withTmp((dir) => {
    const path = join(dir, "config.json");
    writeCloudConfig(
      { apiKey: "secret", agentId: "a", baseUrl: CLOUD_BASE_URL },
      path,
    );
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test("rewrite corrects perms of an existing wider-mode file", () => {
  withTmp((dir) => {
    const path = join(dir, "config.json");
    writeFileSync(path, "{}", { mode: 0o644 });
    writeCloudConfig(
      { apiKey: "k", agentId: "a", baseUrl: CLOUD_BASE_URL },
      path,
    );
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

test("baseUrl trailing slashes are stripped on write", () => {
  withTmp((dir) => {
    const path = join(dir, "config.json");
    writeCloudConfig(
      { apiKey: "k", agentId: "a", baseUrl: "https://brain.example.com//" },
      path,
    );
    assert.equal(readCloudConfig(path)?.baseUrl, "https://brain.example.com");
  });
});

test("missing file reads as null", () => {
  withTmp((dir) => {
    assert.equal(readCloudConfig(join(dir, "nope.json")), null);
  });
});

test("malformed JSON reads as null (no throw)", () => {
  withTmp((dir) => {
    const path = join(dir, "config.json");
    writeFileSync(path, "{not json", "utf8");
    assert.equal(readCloudConfig(path), null);
  });
});

test("config without an apiKey reads as null", () => {
  withTmp((dir) => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ agentId: "a" }), "utf8");
    assert.equal(readCloudConfig(path), null);
  });
});

test("config missing baseUrl falls back to the default brain", () => {
  withTmp((dir) => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ apiKey: "k", agentId: "a" }), "utf8");
    assert.equal(readCloudConfig(path)?.baseUrl, CLOUD_BASE_URL);
  });
});

// ---------------------------------------------------------------------
// Atomic write: a crash between truncate and full write must never be
// able to leave a 0-byte (or otherwise truncated) config on disk. The
// only way to guarantee that is to never write in place — write a
// sibling temp file, then rename it over the destination, which POSIX
// guarantees is atomic on the same filesystem. These tests hold both
// `writeConfigObject` and `writeCloudConfig` to that contract without
// mocking `node:fs` (its exports are non-configurable, so
// `mock.method` cannot intercept them): they use a REAL OS-level
// failure — a directory with no write permission, which lets the OS
// reject creation of a brand-new file (the temp sibling) while still
// allowing in-place modification of a file that already exists there
// (the vulnerability an in-place write would have exploited). If either
// function ever regresses to `writeFileSync(path, …)` directly, this
// failure mode disappears and the `assert.throws` below stops
// reproducing it.
// ---------------------------------------------------------------------

test("writeCloudConfig leaves no stray temp file behind after a successful write", () => {
  withTmp((dir) => {
    const path = join(dir, "config.json");
    writeCloudConfig({ apiKey: "k", agentId: "a", baseUrl: CLOUD_BASE_URL }, path);
    const leftovers = readdirSync(dir).filter((name) => name !== "config.json");
    assert.deepEqual(leftovers, [], "no stray temp file after a successful write");
  });
});

test("writeConfigObject leaves no stray temp file behind after a successful write", () => {
  withTmp((dir) => {
    const path = join(dir, "config.json");
    writeConfigObject({ proxy: { capture: false } }, path);
    const leftovers = readdirSync(dir).filter((name) => name !== "config.json");
    assert.deepEqual(leftovers, [], "no stray temp file after a successful write");
  });
});

test("a failure creating the temp file (read-only directory) leaves an existing config completely untouched", () => {
  withTmp((dir) => {
    const path = join(dir, "config.json");
    writeCloudConfig({ apiKey: "original-key", agentId: "a", baseUrl: CLOUD_BASE_URL }, path);
    const before = readFileSync(path, "utf8");

    // No write permission on the directory: the OS refuses to create
    // a NEW directory entry (the temp sibling), but would happily let
    // an in-place `writeFileSync(path, …)` truncate the file that is
    // already there — which is exactly the asymmetry this test needs
    // to prove the implementation never takes the in-place path.
    fsModule.chmodSync(dir, 0o500);
    try {
      assert.throws(
        () => writeCloudConfig({ apiKey: "new-key", agentId: "b", baseUrl: CLOUD_BASE_URL }, path),
        /EACCES|permission/i,
      );
    } finally {
      fsModule.chmodSync(dir, 0o700); // restore so withTmp's rmSync can clean up
    }

    assert.equal(
      readFileSync(path, "utf8"),
      before,
      "the destination must hold either the fully-old or fully-new content, never a truncated write",
    );
    const config = readCloudConfig(path);
    assert.equal(config?.apiKey, "original-key", "the original credential must still be recoverable");
  });
});

test("writeConfigObject: a failure creating the temp file leaves an existing config completely untouched", () => {
  withTmp((dir) => {
    const path = join(dir, "config.json");
    writeConfigObject({ apiKey: "original-key", proxy: { capture: true } }, path);
    const before = readFileSync(path, "utf8");

    fsModule.chmodSync(dir, 0o500);
    try {
      assert.throws(
        () => writeConfigObject({ apiKey: "original-key", proxy: { capture: false } }, path),
        /EACCES|permission/i,
      );
    } finally {
      fsModule.chmodSync(dir, 0o700);
    }

    assert.equal(readFileSync(path, "utf8"), before);
  });
});
