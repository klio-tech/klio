// Curator-config env-block helper tests.
//
// The npm CLI renders a few new lines into ~/.klio/.env when the
// curator is enabled or reconfigured. This file pins the exact
// shape of those lines so a future refactor can't silently change
// what the engine reads.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  curatorEnvLines,
  CURATOR_CADENCE_LABELS,
  type CuratorCadence,
  type CuratorConfig,
} from "../src/curatorConfig.js";


test("CURATOR_CADENCE_LABELS exposes 5 options matching the design", () => {
  // Five cadence options, in order:
  //   hourly, every 4h, daily, on-demand only, disabled.
  // The labels are what the picker renders — keep them stable so
  // a `klio update curator` after a CLI upgrade still recognizes
  // the user's previous choice.
  assert.equal(CURATOR_CADENCE_LABELS.length, 5);
  const slugs = CURATOR_CADENCE_LABELS.map((c) => c.slug).sort();
  assert.deepEqual(slugs, ["daily", "disabled", "every-4h", "hourly", "on-demand"]);
});


test("curatorEnvLines: enabled hourly with model", () => {
  const cfg: CuratorConfig = {
    enabled: true,
    cadence: "hourly",
    model: "ollama/qwen2.5:7b-instruct",
  };
  const lines = curatorEnvLines(cfg);
  assert.match(lines, /^KLIO_CURATOR_ENABLED=true$/m);
  assert.match(lines, /^KLIO_CURATOR_INTERVAL_SECS=3600$/m);
  assert.match(lines, /^KLIO_CURATOR_MODEL=ollama\/qwen2\.5:7b-instruct$/m);
});


test("curatorEnvLines: every-4h cadence", () => {
  const cfg: CuratorConfig = { enabled: true, cadence: "every-4h", model: "" };
  assert.match(curatorEnvLines(cfg), /^KLIO_CURATOR_INTERVAL_SECS=14400$/m);
});


test("curatorEnvLines: daily cadence", () => {
  const cfg: CuratorConfig = { enabled: true, cadence: "daily", model: "" };
  assert.match(curatorEnvLines(cfg), /^KLIO_CURATOR_INTERVAL_SECS=86400$/m);
});


test("curatorEnvLines: on-demand cadence keeps enabled true and uses interval=0 as the sentinel", () => {
  // On-demand mode: the curator is reachable via `klio update
  // curator --run-now` but no scheduled ticks fire. The engine
  // reads `KLIO_CURATOR_INTERVAL_SECS=0` as the "skip APScheduler
  // job registration" sentinel — the lifespan still wires up the
  // session_factory + kms + lock-registry so the run-now endpoint
  // works, but no clock-driven jobs run.
  const cfg: CuratorConfig = { enabled: true, cadence: "on-demand", model: "" };
  const lines = curatorEnvLines(cfg);
  assert.match(lines, /^KLIO_CURATOR_ENABLED=true$/m);
  assert.match(lines, /^KLIO_CURATOR_INTERVAL_SECS=0$/m);
});


test("curatorEnvLines: disabled cadence sets enabled=false", () => {
  const cfg: CuratorConfig = { enabled: false, cadence: "disabled", model: "" };
  const lines = curatorEnvLines(cfg);
  assert.match(lines, /^KLIO_CURATOR_ENABLED=false$/m);
});


test("curatorEnvLines: model omitted when empty (engine falls back to extraction model)", () => {
  // The engine's `effective_curator_model` returns
  // `curator_model or extraction_model`, so writing
  // `KLIO_CURATOR_MODEL=` is equivalent to not writing it. Choose
  // the shape that's least surprising at the env-file level: emit
  // the line with an empty value so a user reading ~/.klio/.env
  // sees the curator config block as a unit.
  const cfg: CuratorConfig = { enabled: true, cadence: "hourly", model: "" };
  const lines = curatorEnvLines(cfg);
  assert.match(lines, /^KLIO_CURATOR_MODEL=$/m);
});
