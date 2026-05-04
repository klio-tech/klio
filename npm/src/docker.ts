// Thin wrapper over `docker` and `docker compose` invocations.
// We shell out rather than using the Docker Engine API directly
// because:
//
//   1. The Engine API socket location varies (Docker Desktop on
//      macOS uses ~/.docker/run/docker.sock, Linux uses
//      /var/run/docker.sock, rootless setups use $XDG_RUNTIME_DIR)
//      — the `docker` CLI already encapsulates all of that.
//   2. Compose semantics (depends_on, profiles, healthchecks) live
//      in the `docker compose` plugin, not the Engine API. Wiring
//      that ourselves would be a meaningful re-implementation.
//   3. Zero dependencies. The npm package's runtime closure stays
//      empty — nothing for users to audit.
//
// The cost: process spawn overhead per call (~30-80ms). That's
// fine for the orchestrator phase (a handful of calls total) and
// completely irrelevant for the once-per-init flow.

import { spawn } from "node:child_process";
import { info, type StepResult } from "./ui.js";

export type ComposeBin = {
  /** Argv0 — usually "docker" or "docker-compose". */
  cmd: string;
  /** Prefix args — ["compose"] for the plugin, [] for v1 standalone. */
  prefix: string[];
};

/**
 * Resolve the right argv prefix for `docker compose`. Returns the
 * plugin form (`docker compose ...`) when available, falls back to
 * the v1 `docker-compose` binary if the user hasn't migrated yet.
 */
export async function resolveComposeBin(): Promise<ComposeBin> {
  // First, try the plugin form. Probing with `docker compose version`
  // distinguishes "docker installed but plugin missing" from "docker
  // not installed at all".
  if (await canRun("docker", ["compose", "version"])) {
    return { cmd: "docker", prefix: ["compose"] };
  }
  if (await canRun("docker-compose", ["version"])) {
    return { cmd: "docker-compose", prefix: [] };
  }
  throw new Error(
    "docker compose not found — install Docker Desktop (https://www.docker.com/products/docker-desktop) " +
      "or the docker compose plugin, then re-run the install.",
  );
}

/**
 * Verify Docker is installed AND the daemon is reachable. Throws
 * with a copy-pasteable remediation message on failure.
 */
export async function preflightDocker(): Promise<string> {
  if (!(await canRun("docker", ["--version"]))) {
    throw new Error(
      "`docker` not found on PATH. Install Docker Desktop " +
        "(https://www.docker.com/products/docker-desktop) and re-run.",
    );
  }
  // `docker info` exits non-zero when the daemon isn't running; that
  // is how we distinguish "Docker is installed" from "Docker is up".
  const result = await capture("docker", [
    "info",
    "--format",
    "{{.ServerVersion}}",
  ]);
  if (result.code !== 0) {
    throw new Error(
      "Docker daemon is not running. " +
        "Open Docker Desktop (or `systemctl start docker` on Linux) and re-run.",
    );
  }
  return `docker ${result.stdout.trim() || "ready"}`;
}

export type ComposeUpOptions = {
  /** Working directory containing docker-compose.yml. */
  cwd: string;
  /** Service names to bring up; empty array = all. */
  services?: string[];
  /** Pull images before starting (default: true). */
  pull?: boolean;
};

/**
 * `docker compose up -d <services>` with stderr streamed to ui.info
 * so users see compose's own progress (image pulls, healthchecks).
 *
 * Returns a one-line status suitable for the green ✓ marker.
 */
export async function composeUp(
  bin: ComposeBin,
  opts: ComposeUpOptions,
): Promise<StepResult> {
  const argv = [...bin.prefix, "up", "-d"];
  if (opts.services && opts.services.length > 0) argv.push(...opts.services);

  await streamCommand(bin.cmd, argv, opts.cwd);

  const label =
    opts.services && opts.services.length > 0
      ? `started ${opts.services.length} service(s)`
      : "stack started";
  return { kind: "ok", status: label };
}

/**
 * Pull images referenced by the compose file. Separated from
 * composeUp so we can show a distinct progress step ("Pulling
 * images…") and so a slow first run doesn't make `docker compose up`
 * appear hung.
 */
export async function composePull(
  bin: ComposeBin,
  opts: ComposeUpOptions,
): Promise<StepResult> {
  const argv = [...bin.prefix, "pull"];
  if (opts.services && opts.services.length > 0) argv.push(...opts.services);
  await streamCommand(bin.cmd, argv, opts.cwd);
  return { kind: "ok", status: "images up to date" };
}

/**
 * `docker compose down -v` — stop + remove containers AND volumes.
 * Used by the `klio down` and `klio uninstall` subcommands.
 */
export async function composeDown(
  bin: ComposeBin,
  cwd: string,
  removeVolumes = false,
): Promise<void> {
  const argv = [...bin.prefix, "down"];
  if (removeVolumes) argv.push("-v");
  await streamCommand(bin.cmd, argv, cwd);
}

/**
 * `docker compose restart <service>` — stop + start a single service
 * without disturbing the rest of the stack. We use this after
 * `klio configure` writes credentials into the bridge container's
 * volume — the daemon loads its keychain at process start, so a
 * configure that lands after the daemon is already running leaves
 * the in-memory token stale until the next process boot.
 */
export async function composeRestart(
  bin: ComposeBin,
  cwd: string,
  service: string,
): Promise<void> {
  const argv = [...bin.prefix, "restart", service];
  await streamCommand(bin.cmd, argv, cwd);
}

/**
 * `docker exec -i <container> <argv...>` with optional stdin.
 * Returns combined stdout. Throws on non-zero exit.
 *
 * Used by the npm package to invoke `klio configure` inside the
 * bridge container after the orchestrator provisions the account
 * (see commands/init.ts for the call site).
 */
export async function dockerExec(
  container: string,
  argv: string[],
  stdin?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container, ...argv], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `docker exec ${container} ${argv.join(" ")} exited ${code}\n${stderr.trim()}`,
          ),
        );
      }
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

// ---- internals ----

async function canRun(cmd: string, args: string[]): Promise<boolean> {
  const r = await capture(cmd, args);
  return r.code === 0;
}

async function capture(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", () => resolve({ code: 127, stdout, stderr }));
    child.on("exit", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

/**
 * Spawn a long-running command, forwarding stderr lines to ui.info
 * as they arrive. We buffer the last ~2 KB so error messages can
 * include recent context without unbounded memory growth.
 */
async function streamCommand(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let tail = "";
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      // Compose writes line-buffered; split + render each line so
      // long pulls show streaming progress instead of one big blob
      // at the end.
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        info(line);
        if (tail.length < 2048) tail += line + "\n";
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${cmd} ${args.join(" ")} exited ${code}\n${tail.trim()}`),
        );
    });
  });
}
