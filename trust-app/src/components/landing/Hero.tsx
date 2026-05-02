export function Hero() {
  return (
    <section
      className="k-section"
      style={{ paddingTop: "6rem", paddingBottom: "5rem" }}
    >
      <div className="k-container">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(220px, auto)",
            gap: "3rem",
            alignItems: "end",
          }}
          className="hero-grid"
        >
          <div>
            <p className="k-eyebrow k-rise" data-stagger="1">
              the memory layer for ai agents
            </p>

            <h1
              className="k-display k-rise"
              data-stagger="2"
              style={{ marginTop: "1.4rem" }}
            >
              Persistent memory.
              <br />
              <em>For every AI agent.</em>
            </h1>

            <p
              className="k-lede k-rise"
              data-stagger="3"
              style={{ marginTop: "2rem" }}
            >
              Klio captures what your AI coding agents see, decide, and prefer —
              and serves it back through seven MCP tools to every agent that asks.
              Claude Code in one window writes; Cursor in another instantly recalls.
              Encrypted at rest under a key only you hold. Cryptographically
              auditable. Open-source under split AGPL/Apache.
            </p>

            <div
              className="k-rise"
              data-stagger="4"
              style={{
                marginTop: "2.4rem",
                display: "flex",
                gap: "0.75rem",
                flexWrap: "wrap",
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
                View on GitHub
              </a>
            </div>
          </div>

          <aside
            className="hero-aside k-rise"
            data-stagger="4"
            style={{
              fontFamily: "var(--font-mono-stack)",
              fontSize: "0.78rem",
              lineHeight: 1.85,
              color: "var(--klio-muted)",
              borderLeft: "1px solid var(--klio-border)",
              paddingLeft: "1.5rem",
              minWidth: "220px",
            }}
          >
            <div style={{ color: "var(--klio-foreground)", marginBottom: "0.4rem" }}>
              v0 · public alpha
            </div>
            <div>license &nbsp;agpl-3 / apache-2</div>
            <div>engine &nbsp;&nbsp;103 tests passing</div>
            <div>bridge &nbsp;&nbsp;13 packages green</div>
            <div>tested &nbsp;&nbsp;macOS · linux</div>
            <div style={{ marginTop: "0.8rem" }}>
              <a
                href="https://github.com/klio-tech/klio"
                target="_blank"
                rel="noreferrer"
                className="k-link"
                style={{ color: "var(--klio-foreground)" }}
              >
                klio-tech/klio →
              </a>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}
