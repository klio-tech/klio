// `klio status` — what's up, where, and as whom.
//
// Reads ~/.klio/runtime/.env for the local-dev creds and queries
// `docker compose ps` for the container state. Prints a JSON
// blob (so other tools can pipe it through jq) plus a human
// summary at the end.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveComposeBin } from "../docker.js";
import { runtimeDir } from "../compose.js";
import { spawn } from "node:child_process";

export async function status(): Promise<void> {
  const dir = runtimeDir();
  const envPath = join(dir, ".env");

  const out: Record<string, unknown> = {
    runtime_dir: dir,
    compose_file: join(dir, "docker-compose.yml"),
    env_file: existsSync(envPath) ? envPath : null,
    user_id: null,
    agent_id: null,
    services: [] as unknown[],
  };

  if (existsSync(envPath)) {
    const env = parseEnv(readFileSync(envPath, "utf8"));
    out.user_id = env["KLIO_LOCAL_USER_ID"] || null;
    out.agent_id = env["KLIO_LOCAL_AGENT_ID"] || null;
  }

  // `docker compose ps --format json` returns a stream of JSON
  // objects (one per service) — handy for structured consumption.
  // We tolerate the case where the stack isn't up: an empty array
  // is the right answer for "no services".
  try {
    const bin = await resolveComposeBin();
    const services = await composePsJson(bin.cmd, [
      ...bin.prefix,
      "ps",
      "--format",
      "json",
    ], dir);
    out.services = services;
  } catch (err) {
    out.services_error = err instanceof Error ? err.message : String(err);
  }

  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

function parseEnv(body: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of body.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

async function composePsJson(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`docker compose ps exited ${code}: ${stderr.trim()}`));
        return;
      }
      // The format produces either:
      //   - one JSON array (newer compose versions)
      //   - newline-delimited JSON objects (older versions)
      const trimmed = stdout.trim();
      if (!trimmed) return resolve([]);
      try {
        const parsed = JSON.parse(trimmed);
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        const items: unknown[] = [];
        for (const line of trimmed.split("\n")) {
          if (!line.trim()) continue;
          try {
            items.push(JSON.parse(line));
          } catch {
            /* skip — partial line, will be retried next call */
          }
        }
        resolve(items);
      }
    });
  });
}
