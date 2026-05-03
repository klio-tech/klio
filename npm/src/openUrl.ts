// Cross-platform "open this URL in the user's browser" helper. We
// shell out to the OS's native handler rather than pulling in a
// dependency like `open` because the npm package's runtime closure
// stays empty — nothing for users to audit.
//
// The browser is launched detached + with stdio ignored so the
// child outlives this Node process and doesn't keep the CLI hanging
// after we've handed control back to the user.

import { spawn } from "node:child_process";
import { platform } from "node:os";

/**
 * Resolve the right argv0 to invoke the OS's URL handler.
 *
 *   - macOS: `open <url>`
 *   - Windows: `start <url>` (resolved via cmd.exe shell semantics)
 *   - Linux/BSD/etc: `xdg-open <url>` (xdg-utils, ubiquitous on
 *     freedesktop systems; users on minimal distros without it
 *     should install it — we don't try to fall back to gnome-open
 *     etc, which are deprecated.)
 *
 * Pure function, parameterised on platform name so callers can
 * unit-test the resolution table without monkeypatching `os.platform`.
 */
export function resolveOpenCommand(p: NodeJS.Platform): string {
  if (p === "darwin") return "open";
  if (p === "win32") return "start";
  return "xdg-open";
}

/**
 * Fire-and-forget: launch the OS browser pointed at `url` and return
 * immediately. We don't await the child because the CLI flow that
 * calls this (the OpenRouter API-key entry step) needs to keep the
 * readline prompt running while the user opens the page.
 */
export function openUrl(url: string): void {
  const cmd = resolveOpenCommand(platform());
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}
