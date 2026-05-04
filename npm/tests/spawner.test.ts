import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runProcess } from "../src/adapters/spawner.js";

test("runProcess returns stdout + exitCode 0 on success", async () => {
  const r = await runProcess("/bin/echo", ["hello"]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /hello/);
});

test("runProcess returns non-zero exitCode on failure", async () => {
  const r = await runProcess("/bin/sh", ["-c", "exit 7"]);
  assert.equal(r.exitCode, 7);
});

test("runProcess rejects with ENOENT when binary absent", async () => {
  await assert.rejects(
    () => runProcess("/no/such/binary/anywhere", []),
    /ENOENT|spawn/,
  );
});

test("runProcess captures stderr separately", async () => {
  const r = await runProcess("/bin/sh", ["-c", "echo err >&2"]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stderr, /err/);
});
