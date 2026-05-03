import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveOpenCommand } from "../src/openUrl.js";

test("resolveOpenCommand picks open on darwin", () => {
  assert.equal(resolveOpenCommand("darwin"), "open");
});

test("resolveOpenCommand picks start on win32", () => {
  assert.equal(resolveOpenCommand("win32"), "start");
});

test("resolveOpenCommand picks xdg-open on linux", () => {
  assert.equal(resolveOpenCommand("linux"), "xdg-open");
});
