import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderBanner } from "../src/banner.js";

test("renderBanner contains the three-bar mark", () => {
  const out = renderBanner("init");
  assert.match(out, /▔▔▔▔▔/);
  assert.match(out, /klio/);
});

test("renderBanner picks subtitle by command", () => {
  assert.match(renderBanner("init"), /memory they share/);
  assert.match(renderBanner("down"), /stopping/);
  assert.match(renderBanner("uninstall"), /removing/);
});

test("renderBanner falls back to neutral subtitle for unknown command", () => {
  const out = renderBanner("status");
  assert.match(out, /klio/);
  assert.doesNotMatch(out, /memory they share/);
});
