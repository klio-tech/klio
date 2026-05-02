import { Frame } from "./Frame";
import type { ReactNode } from "react";

/**
 * Quick-start — terminal session, not a code block.
 *
 * Each command shows realistic post-execution output beneath it,
 * so a developer can see exactly what success looks like before
 * they run anything. No syntax highlighter library; the
 * `tk-*` classes from globals.css colour everything inline.
 */

type Token = { kind?: "comment" | "cmd" | "flag" | "arg" | "ok"; text: string };
type Line =
  | { kind: "cmd"; tokens: Token[] }
  | { kind: "out"; text: string; emphasis?: "ok" | "muted" | "accent" }
  | { kind: "blank" };

const SESSION: Line[] = [
  { kind: "cmd", tokens: [{ kind: "comment", text: "# 1. clone + provision dependencies" }] },
  {
    kind: "cmd",
    tokens: [
      { kind: "cmd", text: "git" },
      { text: " clone https://github.com/klio-tech/klio.git" },
    ],
  },
  { kind: "out", text: "Cloning into 'klio'…  receiving objects: 100% (1247/1247) — 4.3 MiB", emphasis: "muted" },
  {
    kind: "cmd",
    tokens: [
      { kind: "cmd", text: "cd" },
      { text: " klio && " },
      { kind: "cmd", text: "make" },
      { kind: "arg", text: " first-run" },
    ],
  },
  { kind: "out", text: "✔  postgres up · pgvector ready · 5433/tcp",      emphasis: "ok" },
  { kind: "out", text: "✔  redis up · 6380/tcp",                          emphasis: "ok" },
  { kind: "out", text: "✔  ollama (native, metal) · nomic-embed-text",    emphasis: "ok" },
  { kind: "out", text: "✔  alembic upgrade head — 5 migrations applied",  emphasis: "ok" },
  { kind: "out", text: "✔  built  /tmp/klio  /tmp/klio-mcp",              emphasis: "ok" },

  { kind: "blank" },
  { kind: "cmd", tokens: [{ kind: "comment", text: "# 2. provision your account + wire claude code" }] },
  {
    kind: "cmd",
    tokens: [
      { kind: "flag", text: "KLIO_USE_FILE_KEYCHAIN=1" },
      { text: " " },
      { kind: "cmd", text: "/tmp/klio" },
      { kind: "arg", text: " init" },
    ],
  },
  { kind: "out", text: "✔  user_id           0311adba-2cf9-4caf-ae8e-a4b2da552579", emphasis: "ok" },
  { kind: "out", text: "✔  default_space     f11e05be-e340-…  (768d · nomic)",      emphasis: "ok" },
  { kind: "out", text: "✔  patched           ~/.claude.json + ~/.claude/settings.json", emphasis: "ok" },
  { kind: "out", text: "✔  wrote             ~/.klio/local-dev.env  ./.env",        emphasis: "ok" },

  { kind: "blank" },
  { kind: "cmd", tokens: [{ kind: "comment", text: "# 3. start daemon + dashboard" }] },
  {
    kind: "cmd",
    tokens: [
      { kind: "cmd", text: "/tmp/klio" },
      { kind: "arg", text: " daemon" },
      { text: " &" },
      { text: "  " },
      { kind: "cmd", text: "docker" },
      { kind: "arg", text: " compose up -d trust-app" },
    ],
  },
  { kind: "out", text: "→ open http://127.0.0.1:3000", emphasis: "accent" },
];

function token(t: Token, i: number): ReactNode {
  if (!t.kind) return <span key={i}>{t.text}</span>;
  return (
    <span key={i} className={`tk-${t.kind}`}>
      {t.text}
    </span>
  );
}

export function QuickStart() {
  return (
    <section
      id="quick-start"
      className="k-section"
      style={{ scrollMarginTop: "4rem" }}
    >
      <div className="k-container">
        <div
          className="quick-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 5fr) minmax(0, 7fr)",
            gap: "3rem",
            alignItems: "start",
          }}
        >
          <header>
            <p className="k-eyebrow">two minutes</p>
            <h2 className="k-h2" style={{ marginTop: "1rem" }}>
              From zero to recall in five commands.
            </h2>
            <p className="k-lede" style={{ marginTop: "1.2rem" }}>
              Klio runs entirely on your machine. The bridge daemon talks to
              the local engine over a Unix socket; the engine talks to a
              local Postgres + Redis + Ollama. Nothing phones home — there
              is no analytics endpoint to phone.
            </p>
            <p className="k-lede" style={{ marginTop: "1rem" }}>
              <a
                className="k-link"
                style={{ color: "var(--klio-foreground)" }}
                href="https://github.com/klio-tech/klio#quick-start"
                target="_blank"
                rel="noreferrer"
              >
                Full quick-start in the readme →
              </a>
            </p>
          </header>

          <Frame
            path="zsh — /Users/you/klio"
            badge="LIVE"
            footL={
              <>
                <span style={{ color: "var(--klio-accent)" }}>●</span>{" "}
                healthcheck — postgres · redis · ollama
              </>
            }
            footR="elapsed 1m 47s"
            style={{ minWidth: 0 }}
          >
            <div
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.78rem",
                lineHeight: 1.7,
              }}
            >
              {SESSION.map((line, idx) => {
                if (line.kind === "blank") return <div key={idx}>&nbsp;</div>;
                if (line.kind === "out") {
                  const color =
                    line.emphasis === "ok"
                      ? "#9bd486"
                      : line.emphasis === "accent"
                        ? "#0a0a0a"
                        : "#8a8378";
                  return (
                    <div
                      key={idx}
                      style={{ color, paddingLeft: "1.2em" }}
                    >
                      {line.text}
                    </div>
                  );
                }
                return (
                  <div key={idx}>
                    <span style={{ color: "#6f6b62" }}>$ </span>
                    {line.tokens.map(token)}
                  </div>
                );
              })}
            </div>
          </Frame>
        </div>
      </div>
    </section>
  );
}
