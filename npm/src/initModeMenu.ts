// Init-mode menu — the very first choice in `klio init`: where should
// Klio store memory?
//
//   - Cloud (default/recommended): the hosted Klio brain. No Docker,
//     no model setup, no local engine — just an API key. Enter picks
//     it.
//   - Local (self-hosted, Docker): the original six-phase local-first
//     flow (postgres/redis/engine/bridge).
//
// Mirrors `providerMenu.ts`: both side-effect boundaries (`promptFn`
// and `log`) are injected via `ModeMenuDeps` so the test suite stays
// hermetic — this module imports neither `prompt` nor stdout directly.

/** The two memory backends `klio init` can target. */
export type InitMode = "cloud" | "local";

export type ModeMenuDeps = {
  /**
   * Issue an interactive prompt and resolve to the user's response. In
   * production this wraps `./prompt.ts`; in tests it's a stub.
   */
  promptFn: (opts: { message: string; default?: string }) => Promise<string>;
  /** Single-line console writer. */
  log: (line: string) => void;
};

/**
 * Render the two-option mode menu and return the user's pick. Default
 * is Cloud — hitting Enter (empty input) or typing "1" selects it.
 *
 * Re-prompts on any input that isn't `""`/`"1"`/`"2"` (after trim),
 * routing the error line through `deps.log` so a quiet-mode caller can
 * suppress or redirect it.
 */
export async function selectInitMode(deps: ModeMenuDeps): Promise<InitMode> {
  deps.log("");
  deps.log("  Where should Klio store memory?");
  deps.log(
    "    1) Cloud   hosted Klio brain — no Docker, just an API key — recommended",
  );
  deps.log(
    "    2) Local   self-hosted on your machine via Docker (postgres, engine)",
  );
  deps.log("");

  while (true) {
    const choice = await deps.promptFn({ message: "Choice", default: "1" });
    const trimmed = choice.trim();
    if (trimmed === "" || trimmed === "1") return "cloud";
    if (trimmed === "2") return "local";
    deps.log(`      ✗ pick 1 or 2 (got ${JSON.stringify(trimmed)})`);
  }
}
