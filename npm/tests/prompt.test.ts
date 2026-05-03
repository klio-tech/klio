import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Readable, Writable } from "node:stream";
import { prompt } from "../src/prompt.js";

function streams(input: string) {
  const stdin = Readable.from([input]);
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stdin, stdout, chunks };
}

test("prompt returns the typed value", async () => {
  const { stdin, stdout } = streams("hello\n");
  const result = await prompt({ message: "Name", stdin, stdout });
  assert.equal(result, "hello");
});

test("prompt returns the default when input is empty", async () => {
  const { stdin, stdout } = streams("\n");
  const result = await prompt({
    message: "Model",
    default: "claude-3-5-haiku",
    stdin,
    stdout,
  });
  assert.equal(result, "claude-3-5-haiku");
});

test("prompt re-prompts until validator passes", async () => {
  const { stdin, stdout } = streams("bad\nbetter\n");
  const result = await prompt({
    message: "Word",
    validate: (v) => (v.startsWith("b") && v.length > 3 ? null : "too short"),
    stdin,
    stdout,
  });
  assert.equal(result, "better");
});

test("prompt with mask=true does not echo characters", async () => {
  const { stdin, stdout, chunks } = streams("secret\n");
  const result = await prompt({
    message: "Key",
    mask: true,
    stdin,
    stdout,
  });
  assert.equal(result, "secret");
  // The literal value should never appear in output
  assert.doesNotMatch(chunks.join(""), /secret/);
});
