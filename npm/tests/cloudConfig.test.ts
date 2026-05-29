// Unit tests for cloud config persistence (src/cloudConfig.ts):
// the ~/.klio/config.json round-trip, secret-safe 0600 perms, and the
// tolerant read path (missing / malformed / keyless → null, never throw).

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CLOUD_BASE_URL } from "../src/cloud.js";
import {
  cloudConfigPath,
  readCloudConfig,
  writeCloudConfig,
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
