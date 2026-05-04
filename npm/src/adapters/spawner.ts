//
// Tiny wrapper over node:child_process.spawn that resolves to a
// {stdout, stderr, exitCode} record instead of dealing with raw
// streams. Adapters that shell out to a CLI (Claude Code,
// OpenClaw) use this so their tests can inject a fake spawner
// without needing the real binary on PATH.

import { spawn, type SpawnOptions } from "node:child_process";

export type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type Spawner = (
  cmd: string,
  args: string[],
  opts?: SpawnOptions,
) => Promise<ProcessResult>;

export const runProcess: Spawner = (cmd, args, opts) =>
  new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...opts,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
