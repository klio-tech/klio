// `klio uninit` — remove the proxy wiring, and nothing else.
//
// This is the escape hatch, and it needs to work when everything else
// does not. If the proxy is wedged, the user's agent cannot reach a
// model at all, and the ONLY thing standing between them and a working
// session is this command. So it:
//
//   - does not require Docker to be running,
//   - does not require the proxy to be reachable,
//   - does not require the state file to exist or parse,
//   - reports per-step failures and keeps going rather than aborting.
//
// It is scoped to the proxy. It does NOT remove Klio's MCP server,
// hooks or memory — `klio uninstall` is the command for that, and
// conflating the two would mean someone reaching for "stop routing my
// traffic" loses their memory as a side effect.

import { unlinkSync } from "node:fs";
import { spawn } from "node:child_process";

import { readCloudConfig } from "../cloudConfig.js";
import { runtimeDir } from "../compose.js";
import { resolveComposeBin } from "../docker.js";
import { PROXY_SERVICE } from "../proxy/constants.js";
import { pidFilePath } from "../proxy/processSupervisor.js";
import { stopProxy } from "../proxy/stop.js";
import { uninstallSupervisor } from "../proxy/supervisor.js";
import { unwireProxy, type WireProxyResult } from "../proxy/wiring.js";

export type UninitOptions = {
  log?: (line: string) => void;
  /** Leave the proxy running; only undo the config wiring. */
  keepRunning?: boolean;
  claudeSettings?: string;
  codexConfig?: string;
  statePath?: string;
  /** Home directory to clean stale state from. Overridden by tests. */
  home?: string;
  /**
   * Injection seams. Production leaves every one undefined and gets the
   * real implementation; the unit suite substitutes recorders so it
   * never signals a process, shells out to Docker, or unloads the
   * developer's own launchd agent.
   */
  readCloudConfigFn?: typeof readCloudConfig;
  stopProxyFn?: typeof stopProxy;
  uninstallSupervisorFn?: typeof uninstallSupervisor;
  resolveComposeBinFn?: typeof resolveComposeBin;
  stopServiceFn?: (cmd: string, args: string[], cwd: string) => Promise<void>;
};

export async function uninit(opts: UninitOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string) => process.stdout.write(line + "\n"));

  log("");
  log("klio uninit — removing the compression proxy wiring");
  log("");

  // Order matters. Un-wire the agents FIRST, so that even if every
  // later step fails, the user's agent is already talking straight to
  // api.anthropic.com again. Stopping the container first would leave a
  // window in which the config still points at a port that is now dead.
  const wiring = unwireProxy({
    log,
    claudeSettings: opts.claudeSettings,
    codexConfig: opts.codexConfig,
    statePath: opts.statePath,
  });
  describeUnwiring(wiring, log);

  const supervisor = await (opts.uninstallSupervisorFn ?? uninstallSupervisor)();
  log(`  ✓ Supervisor: ${supervisor.detail}`);

  // Which "stop" applies depends on how the proxy is RUN, and the two
  // are not interchangeable. `ensure()` (commands/proxy.ts) already
  // branches on exactly this signal — cloud init writes
  // ~/.klio/config.json, local init never does — and uninit has to
  // branch the same way. It did not, and unconditionally ran `docker
  // compose stop proxy`: on a Docker-free cloud machine that throws a
  // container error while the detached `proxy serve` keeps listening on
  // 8787 until reboot, which is the one thing this command exists to
  // prevent.
  const cloudMode = (opts.readCloudConfigFn ?? readCloudConfig)() !== null;

  if (!opts.keepRunning) {
    if (cloudMode) await stopCloudProxy(opts, log);
    else await stopLocalProxy(opts, log);
  }

  // Independent of `keepRunning` and of the mode: nothing reads this
  // file any more (ownership is proven from the health body, not from a
  // pid on disk), so an older install's copy is stale state that a
  // future reader could mistake for authority. Best-effort by design —
  // a file we cannot delete is not a reason to fail the escape hatch.
  try {
    unlinkSync(pidFilePath(opts.home));
  } catch {
    /* absent or unremovable — neither matters */
  }

  log("");
  if (wiring.errors.length > 0) {
    for (const error of wiring.errors) log(`  ✗ ${error.agent}: ${error.message}`);
    log("");
    log("  Some wiring could not be removed. Your agent may still be pointed at");
    log("  the proxy — check the ANTHROPIC_BASE_URL entry in ~/.claude/settings.json.");
    log("");
    return 1;
  }

  log("  Done. Your agents talk to api.anthropic.com directly again.");
  log("  Re-run `klio init` to turn the proxy back on.");
  log("");
  return 0;
}

function describeUnwiring(result: WireProxyResult, log: (line: string) => void): void {
  const cc = result.claudeCode;
  if (cc) {
    if (cc.changes.length > 0) {
      log(`  ✓ Claude Code: ${cc.settingsPath}`);
      for (const change of cc.changes) {
        log(
          change.to === null
            ? `      removed ${change.key}`
            : `      restored ${change.key} = ${change.to}`,
        );
      }
    } else {
      log("  — Claude Code: nothing of Klio's to remove");
    }
    for (const conflict of cc.conflicts) {
      log(
        `  ! Claude Code: ${conflict.key} is set to something we did not write ` +
          `(${conflict.from}) — left it alone`,
      );
    }
  }

  if (result.codex) {
    log(
      result.codex.changed
        ? `  ✓ Codex: ${result.codex.summary}`
        : `  — Codex: ${result.codex.summary}`,
    );
  }
}

/**
 * Cloud mode: the proxy is a detached host process, stopped by signal —
 * but only once the health body has proven it is ours (proxy/stop.ts).
 *
 * A proxy that could not be stopped is reported with a `!`, never a
 * tick. It is not fatal (the wiring is already gone, so the agent talks
 * to Anthropic directly again), but it is also not nothing: a survivor
 * holding port 8787 is exactly what makes the next `klio init` report
 * success while running on credentials the user rotated away from.
 */
async function stopCloudProxy(opts: UninitOptions, log: (line: string) => void): Promise<void> {
  const result = await (opts.stopProxyFn ?? stopProxy)();
  if (!result.wasRunning) {
    log(`  — Proxy: ${result.detail}`);
  } else if (result.stopped) {
    log(`  ✓ ${result.detail}`);
  } else {
    log(`  ! ${result.detail}`);
    log("    Nothing points at it any more, but re-running `klio init` while it");
    log("    is still up would report success against the OLD process.");
  }
}

/** Local mode: the proxy is a container, stopped by compose. */
async function stopLocalProxy(opts: UninitOptions, log: (line: string) => void): Promise<void> {
  try {
    const bin = await (opts.resolveComposeBinFn ?? resolveComposeBin)();
    const stop = opts.stopServiceFn ?? stopService;
    await stop(bin.cmd, [...bin.prefix, "stop", PROXY_SERVICE], runtimeDir());
    log("  ✓ Proxy container stopped");
  } catch (err) {
    // Not a failure of uninit's purpose. The wiring is gone, so the
    // agent works; a still-running container is inert and costs a few
    // MB of RAM.
    log(
      `  ! Could not stop the proxy container ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        `Harmless — nothing points at it any more.`,
    );
  }
}

async function stopService(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `exited ${code}`)),
    );
  });
}
