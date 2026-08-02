import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CHECK_INTERVAL_SECONDS,
  LAUNCHD_LABEL,
  SYSTEMD_TIMER,
  SYSTEMD_UNIT,
  detectSupervisor,
  renderLaunchAgent,
  renderSystemdTimer,
  renderSystemdUnit,
  resolveKlioCommand,
  supervisorPaths,
} from "../src/proxy/supervisor.js";

test("detectSupervisor maps each platform to its init system", () => {
  assert.equal(detectSupervisor("darwin"), "launchd");
  assert.equal(detectSupervisor("linux"), "systemd");
  assert.equal(detectSupervisor("win32"), "windows");
  assert.equal(detectSupervisor("aix" as NodeJS.Platform), "unsupported");
});

test("supervisorPaths puts units where the user's init system looks", () => {
  const paths = supervisorPaths("/home/testuser");
  assert.equal(
    paths.launchAgent,
    `/home/testuser/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
  );
  assert.equal(paths.systemdUnit, `/home/testuser/.config/systemd/user/${SYSTEMD_UNIT}`);
  assert.equal(paths.systemdTimer, `/home/testuser/.config/systemd/user/${SYSTEMD_TIMER}`);
});

// ---- launchd ----------------------------------------------------------

test("launchd KeepAlive restarts on failure only, not on every exit", () => {
  // `<key>KeepAlive</key><true/>` would mean "restart whenever this
  // exits" — and the check exits 0 as soon as it succeeds. launchd
  // would respawn it in a tight loop, throttle it to every 10s, and
  // fill the system log with complaints about a job that is working.
  const plist = renderLaunchAgent(["/usr/bin/klio", "proxy", "ensure"]);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test("launchd agent runs at load, which is what covers a reboot", () => {
  // Docker's `restart: unless-stopped` cannot help if the Docker daemon
  // itself is not running — and Docker Desktop does not always start at
  // login. RunAtLoad is the layer that covers that.
  const plist = renderLaunchAgent(["/usr/bin/klio", "proxy", "ensure"]);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, new RegExp(`<key>StartInterval</key>\\s*<integer>${CHECK_INTERVAL_SECONDS}</integer>`));
});

test("launchd plist escapes XML metacharacters in the command", () => {
  // An unescaped `&` in a path makes the plist unparseable, and
  // launchctl's error for that is not obvious.
  const plist = renderLaunchAgent(["/opt/my & co/klio", "proxy", "ensure"]);
  assert.match(plist, /<string>\/opt\/my &amp; co\/klio<\/string>/);
  assert.doesNotMatch(plist, /<string>[^<]*[^&;]& /);
});

test("launchd plist carries the label and every argument", () => {
  const plist = renderLaunchAgent(["/usr/local/bin/klio", "proxy", "ensure"]);
  assert.match(plist, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  assert.match(plist, /<string>\/usr\/local\/bin\/klio<\/string>/);
  assert.match(plist, /<string>proxy<\/string>/);
  assert.match(plist, /<string>ensure<\/string>/);
});

// ---- systemd ----------------------------------------------------------

test("systemd unit does not pair Type=oneshot with Restart=always", () => {
  // systemd rejects that combination. The periodic behaviour belongs in
  // the timer; the unit only needs to retry a transient failure such as
  // a Docker socket that is not up yet.
  const unit = renderSystemdUnit(["/usr/bin/klio", "proxy", "ensure"]);
  assert.match(unit, /Type=oneshot/);
  assert.match(unit, /Restart=on-failure/);
  assert.doesNotMatch(unit, /Restart=always/);
});

test("systemd timer is persistent, which is what covers a reboot", () => {
  const timer = renderSystemdTimer();
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /OnBootSec=/);
  assert.match(timer, new RegExp(`OnUnitActiveSec=${CHECK_INTERVAL_SECONDS}s`));
  assert.match(timer, new RegExp(`Unit=${SYSTEMD_UNIT}`));
});

test("systemd ExecStart quotes arguments containing spaces", () => {
  const unit = renderSystemdUnit(["/opt/my dir/klio", "proxy", "ensure"]);
  assert.match(unit, /ExecStart="\/opt\/my dir\/klio" proxy ensure/);
});

test("systemd ExecStart leaves ordinary paths unquoted", () => {
  const unit = renderSystemdUnit(["/usr/bin/klio", "proxy", "ensure"]);
  assert.match(unit, /ExecStart=\/usr\/bin\/klio proxy ensure/);
});

// ---- the command the unit runs ----------------------------------------

test("resolveKlioCommand uses the real binary path for a normal install", () => {
  const cmd = resolveKlioCommand("/usr/local/lib/node_modules/@klio-tech/klio/bin/klio.mjs", "/usr/local/bin/node");
  assert.deepEqual(cmd, [
    "/usr/local/bin/node",
    "/usr/local/lib/node_modules/@klio-tech/klio/bin/klio.mjs",
    "proxy",
    "ensure",
  ]);
});

test("resolveKlioCommand avoids the npx cache, which gets garbage collected", () => {
  // The primary onboarding path is `npx @klio-tech/klio init`, which
  // unpacks into `_npx/<hash>/`. npm cleans that up. A plist pointing
  // into it works today and silently stops working later — leaving a
  // supervisor that `klio doctor` reports as present and that does
  // nothing, which is worse than having none.
  const cmd = resolveKlioCommand(
    "/Users/me/.npm/_npx/a1b2c3/node_modules/@klio-tech/klio/bin/klio.mjs",
    "/usr/local/bin/node",
    "0.9.2",
  );
  assert.deepEqual(cmd, ["npx", "-y", "@klio-tech/klio@0.9.2", "proxy", "ensure"]);
});

test("resolveKlioCommand handles a Windows-style npx cache path", () => {
  const cmd = resolveKlioCommand(
    "C:\\Users\\me\\AppData\\npm-cache\\_npx\\a1b2\\node_modules\\@klio-tech\\klio\\bin\\klio.mjs",
    "C:\\Program Files\\nodejs\\node.exe",
    "0.9.2",
  );
  assert.deepEqual(cmd, ["npx", "-y", "@klio-tech/klio@0.9.2", "proxy", "ensure"]);
});

test("resolveKlioCommand falls back to npx when argv[1] is unknown", () => {
  assert.deepEqual(resolveKlioCommand("", "/usr/bin/node"), [
    "npx",
    "-y",
    "@klio-tech/klio",
    "proxy",
    "ensure",
  ]);
});

test("the supervisor command is a check, not the proxy itself", () => {
  // The unit invokes `klio proxy ensure`, which probes and only acts if
  // the probe fails. That keeps it idempotent and cheap enough to run
  // every minute, and means the unit encodes nothing about HOW the
  // proxy runs — if the stack moves off Docker, only `ensure` changes.
  const cmd = resolveKlioCommand("/usr/bin/klio", "/usr/bin/node");
  assert.deepEqual(cmd.slice(-2), ["proxy", "ensure"]);
});
