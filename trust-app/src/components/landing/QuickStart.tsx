import type { ReactNode } from "react";

/**
 * Get-started block. Code is hand-tokenized into <span> elements with
 * `tk-*` classes (defined in globals.css) so we get coloured highlights
 * without a JS syntax-highlighter library — saves a runtime dep, keeps
 * the page weight in single-digit kilobytes.
 */

type Token = { kind?: "comment" | "cmd" | "flag" | "arg"; text: string };
type Line = { prompt?: string; tokens: Token[] };

const SCRIPT: Line[] = [
  { tokens: [{ kind: "comment", text: "# 1. clone + provision dependencies" }] },
  { prompt: "$", tokens: [{ kind: "cmd", text: "git" }, { text: " clone https://github.com/klio-tech/klio.git" }] },
  { prompt: "$", tokens: [{ kind: "cmd", text: "cd" }, { text: " klio && " }, { kind: "cmd", text: "make" }, { kind: "arg", text: " first-run" }] },
  { tokens: [{ text: "" }] },
  { tokens: [{ kind: "comment", text: "# 2. start the engine in another terminal" }] },
  { prompt: "$", tokens: [{ kind: "cmd", text: "make" }, { kind: "arg", text: " engine" }] },
  { tokens: [{ text: "" }] },
  { tokens: [{ kind: "comment", text: "# 3. provision your account + wire claude code" }] },
  { prompt: "$", tokens: [{ kind: "flag", text: "KLIO_USE_FILE_KEYCHAIN=1" }, { text: " " }, { kind: "cmd", text: "/tmp/klio" }, { kind: "arg", text: " init" }] },
  { tokens: [{ text: "" }] },
  { tokens: [{ kind: "comment", text: "# 4. run the bridge daemon + memory dashboard" }] },
  { prompt: "$", tokens: [{ kind: "flag", text: "KLIO_USE_FILE_KEYCHAIN=1" }, { text: " " }, { kind: "cmd", text: "/tmp/klio" }, { kind: "arg", text: " daemon" }, { text: " &" }] },
  { prompt: "$", tokens: [{ kind: "cmd", text: "docker" }, { text: " compose up -d trust-app" }] },
  { tokens: [{ text: "" }] },
  { tokens: [{ kind: "comment", text: "# 5. open" }] },
  { prompt: "$", tokens: [{ kind: "cmd", text: "open" }, { text: " http://127.0.0.1:3000" }] },
];

function renderToken(t: Token, i: number): ReactNode {
  if (!t.kind) return <span key={i}>{t.text}</span>;
  return <span key={i} className={`tk-${t.kind}`}>{t.text}</span>;
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
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 5fr) minmax(0, 7fr)",
            gap: "3rem",
            alignItems: "start",
          }}
          className="quick-grid"
        >
          <header>
            <p className="k-eyebrow">two minutes</p>
            <h2 className="k-h2" style={{ marginTop: "1rem" }}>
              Get started with five commands.
            </h2>
            <p className="k-lede" style={{ marginTop: "1.2rem" }}>
              Klio runs entirely on your machine. The bridge daemon talks to
              the local engine over a Unix socket; the engine talks to a
              local Postgres + Redis + Ollama. Nothing phones home.
            </p>
            <p className="k-lede" style={{ marginTop: "1rem" }}>
              <a
                className="k-link"
                style={{ color: "var(--klio-foreground)" }}
                href="https://github.com/klio-tech/klio#quick-start"
                target="_blank"
                rel="noreferrer"
              >
                Full quick-start in the repo readme →
              </a>
            </p>
          </header>

          <pre className="k-code" aria-label="Klio quick-start commands">
            {SCRIPT.map((line, idx) => (
              <div key={idx} style={{ minHeight: "1.7em" }}>
                {line.prompt && <span className="tk-prompt">{line.prompt}</span>}
                {line.tokens.map(renderToken)}
              </div>
            ))}
          </pre>
        </div>
      </div>
    </section>
  );
}
