/**
 * Quick-start — numbered editorial steps. Each step is a serif-headed
 * passage with a clean indented monospace code block underneath.
 * No terminal chrome, no traffic-light dots, no "elapsed 1m 47s"
 * theatrics. The information is the same; the form is editorial.
 *
 * Post-0.4.1 reality: the user types ONE command (`npx @klio-tech/klio
 * init`). Everything else happens inside that command — provider
 * menu, model picker, agent wiring, the wow moment. So the three
 * numbered "steps" reflect the user's experience as they progress
 * through the single CLI session, NOT separate commands they invoke.
 *
 * Code blocks under steps 02 and 03 show what the CLI prints rather
 * than what the user types — matches the editorial-specimen style
 * the rest of the landing uses.
 */

const STEPS: { n: string; title: string; lines: string[]; note: string }[] = [
  {
    n: "01",
    title: "Type one command.",
    lines: ["npx @klio-tech/klio init"],
    note: "Pulls four container images (engine, bridge, dashboard, plus Postgres + Redis), boots them locally, runs migrations. ~30 seconds on a warm Docker, ~2 min on the first run.",
  },
  {
    n: "02",
    title: "Pick a model provider.",
    lines: [
      "Pick your model provider:",
      "  1) OpenRouter   one API key, many models — recommended",
      "  2) Ollama       fully local, your text never leaves the machine",
      "  3) Custom       any OpenAI-compatible endpoint",
      "Choice [1] › ⏎",
    ],
    note: "The CLI validates your pick with a one-token test request (≈$0.0001) before continuing. Pick Ollama and Klio runs entirely on your laptop with zero outbound traffic.",
  },
  {
    n: "03",
    title: "Type one memory. Klio proves recall.",
    lines: [
      'Your memory › I prefer Bun runtime over Node and npm.',
      "  ✓ stored as fact (id: 7a2c…)",
      "  ✓ found in top result",
    ],
    note: "Klio detects every AI agent on your machine — Claude Code, Claude Desktop, Cursor, Codex, OpenCode, OpenClaw — and patches each one's MCP config. Open any of them and ask 'what do you know about me?' — it recalls.",
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
              From zero to recall in one command.
            </h2>
            <p className="k-lede" style={{ marginTop: "1.2rem" }}>
              Klio runs entirely on your machine. One <code>npx</code>{" "}
              invocation pulls a handful of containers, wires every AI
              agent you have, and asks you to type one memory to prove
              the loop works. Nothing phones home — there is no
              analytics endpoint to phone.
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
                    fontFamily: "var(--font-mono-stack)",
                    fontWeight: 700,
                    fontSize: "clamp(2rem, 3.4vw, 2.8rem)",
                    lineHeight: 0.95,
                    letterSpacing: "-0.025em",
                    color: "var(--klio-foreground)",
                  }}
                >
                  {s.n}
                </div>

                {/* Title + code + note */}
                <div>
                  <h3
                    style={{
                      fontFamily: "var(--font-mono-stack)",
                      fontWeight: 700,
                      fontSize: "1.18rem",
                      lineHeight: 1.3,
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
                </div>
              </article>
            ))}

            {/* Closing line */}
            <p
              style={{
                marginTop: "2.4rem",
                fontFamily: "var(--font-mono-stack)",
                fontWeight: 600,
                fontSize: "1.05rem",
                color: "var(--klio-foreground)",
                letterSpacing: "-0.005em",
              }}
            >
              Then{" "}
              <a
                href="http://127.0.0.1:3000"
                className="k-link"
                style={{ color: "var(--klio-foreground)" }}
              >
                open the dashboard
              </a>
              {" "}— your memories, your machine.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
