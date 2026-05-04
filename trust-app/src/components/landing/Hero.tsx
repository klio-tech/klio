/**
 * Hero — split layout. Editorial serif H1 on the left; on the right,
 * an annotated specimen of what an agent actually receives back from
 * a recall() call. No terminal chrome — the typography is the
 * container.
 *
 * Below the lede sits a single-row install-command panel
 * (InstallSnippet) — the fastest path for a visitor who already
 * knows they want to try it. The traditional CTAs sit immediately
 * below for visitors who'd rather read docs first.
 */

import { InstallSnippet } from "./InstallSnippet";

const ENTRIES = [
  {
    n: "01",
    kind: "memory",
    text: "User prefers Bun runtime over Node and npm for JavaScript projects.",
  },
  {
    n: "02",
    kind: "decision",
    text: "Deploy on Railway, not Fly.io — reduces code complexity.",
  },
  {
    n: "03",
    kind: "memory",
    text: "Per-space embeddings with shadow tables (768 / 1024 / 1536).",
  },
];

export function Hero() {
  return (
    <section
      className="k-section"
      style={{ paddingTop: "5.5rem", paddingBottom: "5rem" }}
    >
      <div className="k-container">
        <div
          className="hero-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.05fr) minmax(0, 0.95fr)",
            gap: "4rem",
            alignItems: "center",
          }}
        >
          {/* Left — editorial */}
          <div>
            <p className="k-eyebrow k-rise" data-stagger="1">
              shared memory · cross-agent collaboration
            </p>

            <h1
              className="k-display k-rise"
              data-stagger="2"
              style={{ marginTop: "1.4rem" }}
            >
              Let your agents
              <br />
              <em>collaborate.</em>
            </h1>

            <p
              className="k-lede k-rise"
              data-stagger="3"
              style={{ marginTop: "1.8rem" }}
            >
              Klio is the shared memory layer for every AI coding agent
              on your machine. What one learns, the rest know — encrypted,
              open-source, and entirely on your laptop.
            </p>

            {/* Install snippet — the fastest path for a visitor who's
                already convinced. The CTAs below stay for the rest. */}
            <div className="k-rise" data-stagger="4">
              <InstallSnippet />
            </div>

            <div
              className="k-rise"
              data-stagger="5"
              style={{
                marginTop: "2.4rem",
                display: "flex",
                gap: "0.65rem",
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <a className="k-btn k-btn--primary" href="#quick-start">
                Get started
                <span aria-hidden style={{ transform: "translateY(-1px)" }}>→</span>
              </a>
              <a
                className="k-btn k-btn--ghost"
                href="https://github.com/klio-tech/klio"
                target="_blank"
                rel="noreferrer"
              >
                <span aria-hidden style={{ marginRight: "0.3rem" }}>★</span>
                Star on GitHub
              </a>
              <span
                style={{
                  marginLeft: "0.25rem",
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: "0.72rem",
                  color: "var(--klio-faint)",
                }}
              >
                v0.1.0 · open source · 0 telemetry
              </span>
            </div>
          </div>

          {/* Right — recall specimen, no terminal chrome */}
          <aside
            className="k-rise"
            data-stagger="3"
            style={{ minWidth: 0, paddingLeft: "0.5rem" }}
          >
            {/* Setup line — the cross-agent recall story */}
            <p
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.92rem",
                fontWeight: 500,
                lineHeight: 1.5,
                color: "var(--klio-muted)",
                maxWidth: "36ch",
              }}
            >
              What another agent sees on{" "}
              <code style={{ color: "var(--klio-foreground)", fontWeight: 600 }}>
                recall(&hellip;)
              </code>
              {" "}— milliseconds after the first one writes.
            </p>

            {/* Top hairline */}
            <hr
              style={{
                border: 0,
                height: 1,
                background: "var(--klio-foreground)",
                margin: "1.4rem 0 0.9rem",
              }}
            />

            {/* Three numbered specimen rows */}
            <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {ENTRIES.map((e) => (
                <li
                  key={e.n}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto auto 1fr",
                    columnGap: "1.1rem",
                    alignItems: "baseline",
                    paddingBlock: "0.7rem",
                    borderBottom: "1px solid var(--klio-border)",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono-stack)",
                      fontSize: "0.7rem",
                      color: "var(--klio-faint)",
                      letterSpacing: "0.08em",
                    }}
                  >
                    {e.n}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono-stack)",
                      fontSize: "0.7rem",
                      fontWeight: 600,
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      color: "var(--klio-foreground)",
                      padding: "0.18rem 0.5rem",
                      border: "1px solid var(--klio-border-strong)",
                      borderRadius: "2px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {e.kind}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono-stack)",
                      fontSize: "0.84rem",
                      lineHeight: 1.45,
                      color: "var(--klio-foreground)",
                    }}
                  >
                    {e.text}
                  </span>
                </li>
              ))}
            </ol>

            {/* Bottom annotation */}
            <p
              style={{
                marginTop: "1rem",
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.72rem",
                color: "var(--klio-muted)",
                letterSpacing: "0.02em",
              }}
            >
              ranked by cosine · 768-d nomic · 4.2 ms
              <br />
              <span style={{ color: "var(--klio-faint)" }}>
                from your space — encrypted on disk, never leaves your laptop.
              </span>
            </p>
          </aside>
        </div>
      </div>
    </section>
  );
}
