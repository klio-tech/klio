import { strict as assert } from "node:assert";
import { test } from "node:test";

import { filterRequestHeaders, filterResponseHeaders, HOP_BY_HOP } from "../src/proxy/headers.js";

test("hop-by-hop headers are dropped from requests", () => {
  const out = filterRequestHeaders({
    "x-api-key": "sk-abc",
    "content-type": "application/json",
    connection: "keep-alive",
    "transfer-encoding": "chunked",
    "keep-alive": "timeout=5",
    host: "localhost:8787",
  });
  assert.equal(out["x-api-key"], "sk-abc");
  assert.equal(out["content-type"], "application/json");
  for (const dropped of ["connection", "transfer-encoding", "keep-alive", "host"]) {
    assert.equal(out[dropped], undefined, `${dropped} must not be forwarded`);
  }
});

test("unknown headers survive — deny list, not allow list", () => {
  const out = filterRequestHeaders({ "anthropic-beta": "tools-2026", "x-brand-new": "1" });
  assert.equal(out["anthropic-beta"], "tools-2026");
  assert.equal(out["x-brand-new"], "1");
});

test("rate-limit and retry headers reach the client", () => {
  const h = new Headers({
    "anthropic-ratelimit-requests-remaining": "42",
    "retry-after": "3",
    "request-id": "req_1",
    connection: "close",
  });
  const out = filterResponseHeaders(h);
  assert.equal(out["anthropic-ratelimit-requests-remaining"], "42");
  assert.equal(out["retry-after"], "3");
  assert.equal(out["request-id"], "req_1");
  assert.equal(out["connection"], undefined);
});

test("array-valued request headers collapse to the first value", () => {
  const out = filterRequestHeaders({ "x-multi": ["a", "b"] });
  assert.equal(out["x-multi"], "a");
});

test("the deny list is lowercase and includes the RFC set", () => {
  for (const name of ["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authenticate", "proxy-authorization"]) {
    assert.ok(HOP_BY_HOP.has(name), `${name} missing from deny list`);
  }
});
