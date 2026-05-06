// `klio update` top-level routing tests.
//
// E1 wires the subcommand into the CLI dispatch and provides a
// menu picker that selects between curator / agents / provider
// blocks (whose bodies arrive in E2-E4). Cancel exits cleanly.
//
// The block bodies are stubbed in this commit, so the tests only
// assert the routing decisions, not the side effects of each
// block. E2-E4's tests will cover those.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { runUpdate, parseUpdateTarget } from "../src/commands/update.js";


test("parseUpdateTarget recognises the three direct subcommands", () => {
  assert.equal(parseUpdateTarget(["curator"]), "curator");
  assert.equal(parseUpdateTarget(["agents"]), "agents");
  assert.equal(parseUpdateTarget(["provider"]), "provider");
});

test("parseUpdateTarget returns 'menu' when no subcommand is given", () => {
  assert.equal(parseUpdateTarget([]), "menu");
});

test("parseUpdateTarget rejects unknown targets with 'unknown'", () => {
  assert.equal(parseUpdateTarget(["foo"]), "unknown");
  assert.equal(parseUpdateTarget(["DELETE"]), "unknown");
});
