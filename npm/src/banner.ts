// Visual banner shown at the top of every klio CLI command. The
// three-bar mark is rendered with Unicode upper-block characters so
// it's faithful in any terminal that handles UTF-8 — no nerd-font
// dependency, no PNG, no ANSI image protocol.
//
// We swap subtitles per command so the banner is functional, not
// just decoration: a user running `klio down` sees "stopping the
// stack — your memories are safe on disk", which doubles as
// reassurance that volumes survive. Unknown commands fall back to a
// neutral subtitle so we never crash on a typo or new subcommand.

const SUBTITLES: Record<string, string> = {
  init: "give every AI agent a memory they share",
  down: "stopping the stack — your memories are safe on disk",
  uninstall: "removing Klio — your agent configs are restored",
};

const FALLBACK_SUBTITLE = "persistent memory for AI agents";

/**
 * Render the klio banner as a single string. The caller is expected
 * to write it to stdout (we don't write directly so callers can pipe
 * it through a colourer, capture it for tests, or compose it with
 * other output).
 */
export function renderBanner(command: string): string {
  const subtitle = SUBTITLES[command] ?? FALLBACK_SUBTITLE;
  return [
    "",
    "   ▔▔▔▔▔",
    "     ▔▔▔     klio",
    `   ▔▔▔▔▔     ${subtitle}`,
    "",
  ].join("\n");
}
