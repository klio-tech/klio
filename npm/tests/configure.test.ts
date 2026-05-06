// `klio configure` routing + side-effect tests.
//
// D1 introduces the top-level `klio configure` subcommand with two
// targets: `auto-update {apply, notify, off}` (writes
// KLIO_AUTO_UPDATE into ~/.klio/.env) and `email <addr>` (POSTs to
// the engine's /v1/auth/login-link to mint a magic link).
//
// We don't try to assert the negative-path exit codes for the email
// validator because process.exit kills the node:test runner; the
// positive path coverage plus manual smoke is enough. See self-review
// in the implementation report.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseConfigureTarget,
  runConfigure,
} from "../src/commands/configure.js";
import { mergeEnvFile } from "../src/envFile.js";


function tmpEnv(): string {
  return join(mkdtempSync(join(tmpdir(), "klio-configtest-")), ".env");
}


test("parseConfigureTarget recognises known targets", () => {
  assert.equal(parseConfigureTarget(["auto-update"]), "auto-update");
  assert.equal(parseConfigureTarget(["email"]), "email");
  assert.equal(parseConfigureTarget([]), "menu");
  assert.equal(parseConfigureTarget(["bogus"]), "unknown");
});


test("configure auto-update apply writes KLIO_AUTO_UPDATE=apply to env", async () => {
  const envPath = tmpEnv();
  // Pre-existing key must survive — confirm targeted-merge semantics.
  mergeEnvFile(envPath, { KLIO_OTHER: "preserved" });
  await runConfigure({
    args: ["auto-update", "apply"],
    envPath,
  });
  const content = readFileSync(envPath, "utf8");
  assert.match(content, /^KLIO_AUTO_UPDATE=apply$/m);
  assert.match(content, /^KLIO_OTHER=preserved$/m);
});


test("configure auto-update notify writes notify mode", async () => {
  const envPath = tmpEnv();
  await runConfigure({ args: ["auto-update", "notify"], envPath });
  assert.match(readFileSync(envPath, "utf8"), /^KLIO_AUTO_UPDATE=notify$/m);
});


test("configure auto-update off writes off mode", async () => {
  const envPath = tmpEnv();
  await runConfigure({ args: ["auto-update", "off"], envPath });
  assert.match(readFileSync(envPath, "utf8"), /^KLIO_AUTO_UPDATE=off$/m);
});


test("configure email posts to /v1/auth/login-link with the address", async () => {
  const captured: { url?: string; body?: string; method?: string } = {};
  const fetchFn = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.url = String(input);
    captured.body = String(init?.body ?? "");
    captured.method = init?.method;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  await runConfigure({
    args: ["email", "abhishek@example.com"],
    engineURL: "http://127.0.0.1:8000",
    fetchFn,
  });

  assert.equal(captured.url, "http://127.0.0.1:8000/v1/auth/login-link");
  assert.equal(captured.method, "POST");
  assert.match(captured.body || "", /"email":\s*"abhishek@example\.com"/);
});


test("configure email trims trailing slashes from engineURL", async () => {
  // Defensive: callers may pass either http://host:8000 or
  // http://host:8000/ — both must produce the same login-link URL.
  let url: string | undefined;
  const fetchFn = (async (
    input: RequestInfo | URL,
  ): Promise<Response> => {
    url = String(input);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  await runConfigure({
    args: ["email", "user@example.com"],
    engineURL: "http://127.0.0.1:8000///",
    fetchFn,
  });

  assert.equal(url, "http://127.0.0.1:8000/v1/auth/login-link");
});
