/**
 * Quick-start — numbered editorial steps. Each step is a serif-headed
 * passage with a clean indented monospace code block underneath.
 * No terminal chrome, no traffic-light dots, no "elapsed 1m 47s"
 * theatrics. The information is the same; the form is editorial.
 */

const STEPS: { n: string; title: string; lines: string[]; note?: string }[] = [
  {
    n: "01",
    title: "Clone the repo, bring everything up.",
    lines: [
      "git clone https://github.com/klio-tech/klio.git",
      "cd klio && make first-run",
    ],
    note: "Brings up Postgres + Redis + Ollama, runs migrations, builds /tmp/klio and /tmp/klio-mcp.",
  },
  {
    n: "02",
    title: "Provision your account, wire Claude Code.",
    lines: ["KLIO_USE_FILE_KEYCHAIN=1 /tmp/klio init"],
    note: "Patches ~/.claude.json (MCP server) and ~/.claude/settings.json (six hooks + permissions). Writes ~/.klio/local-dev.env so the dashboard can auto-login.",
  },
  {
    n: "03",
    title: "Run the daemon, start the dashboard.",
    lines: [
      "KLIO_USE_FILE_KEYCHAIN=1 /tmp/klio daemon &",
      "docker compose up -d trust-app",
    ],
    note: "Daemon binds the Unix socket; dashboard becomes available at http://127.0.0.1:3000.",
  },
];

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
            gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.6fr)",
            gap: "4rem",
            alignItems: "start",
          }}
        >
          <header>
            <p className="k-eyebrow">two minutes</p>
            <h2 className="k-h2" style={{ marginTop: "1rem" }}>
              From zero to recall in three steps.
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

          <div>
            {STEPS.map((s, i) => (
              <article
                key={s.n}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(80px, 0.14fr) minmax(0, 1fr)",
                  columnGap: "1.6rem",
                  paddingBlock: "2.2rem",
                  borderTop: i === 0 ? "1px solid var(--klio-foreground)" : "0",
                  borderBottom: "1px solid var(--klio-foreground)",
                }}
                className="quick-step"
              >
                {/* Numeral */}
                <div
                  style={{
                    fontFamily: "var(--font-serif-stack)",
                    fontStyle: "italic",
                    fontSize: "clamp(2.4rem, 4vw, 3.4rem)",
                    lineHeight: 0.95,
                    letterSpacing: "-0.03em",
                    color: "var(--klio-foreground)",
                  }}
                >
                  {s.n}
                </div>

                {/* Title + code + note */}
                <div>
                  <h3
                    style={{
                      fontFamily: "var(--font-serif-stack)",
                      fontWeight: 400,
                      fontSize: "1.45rem",
                      lineHeight: 1.25,
                      letterSpacing: "-0.012em",
                      color: "var(--klio-foreground)",
                      marginBottom: "1rem",
                    }}
                  >
                    {s.title}
                  </h3>

                  <pre
                    style={{
                      margin: 0,
                      padding: "1rem 1.2rem",
                      borderLeft: "2px solid var(--klio-foreground)",
                      background: "var(--klio-paper)",
                      fontFamily: "var(--font-mono-stack)",
                      fontSize: "0.86rem",
                      lineHeight: 1.7,
                      color: "var(--klio-foreground)",
                      overflowX: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {s.lines.map((line, idx) => (
                      <div key={idx}>{line}</div>
                    ))}
                  </pre>

                  {s.note && (
                    <p
                      style={{
                        marginTop: "1rem",
                        fontFamily: "var(--font-mono-stack)",
                        fontSize: "0.78rem",
                        color: "var(--klio-muted)",
                        lineHeight: 1.55,
                        maxWidth: "70ch",
                      }}
                    >
                      {s.note}
                    </p>
                  )}
                </div>
              </article>
            ))}

            {/* Closing line — dashboard URL as an editorial flourish */}
            <p
              style={{
                marginTop: "2.4rem",
                fontFamily: "var(--font-serif-stack)",
                fontStyle: "italic",
                fontSize: "1.35rem",
                color: "var(--klio-foreground)",
                letterSpacing: "-0.01em",
              }}
            >
              Then{" "}
              <a
                href="http://127.0.0.1:3000"
                className="k-link"
                style={{ color: "var(--klio-foreground)" }}
              >
                open the dashboard
              </a>{" "}
              — your memories, your machine.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
