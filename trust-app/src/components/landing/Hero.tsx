import { Frame } from "./Frame";
import { Json } from "./Json";

/**
 * Hero — split layout. Editorial serif H1 on the left, a real-looking
 * MCP recall response in a calm paper-style card on the right.
 *
 * The card isn't decorative — it's literally the JSON shape that
 * klio-mcp returns to a calling agent. A developer reading the
 * page recognises the protocol immediately and the value prop
 * lands without prose having to claim it.
 */

const RECALL_RESPONSE = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    content: [
      {
        type: "text",
        text:
          "Found 3 relevant entries:\n" +
          "1. [memory]   User prefers Bun runtime over Node and npm\n" +
          "2. [decision] Deploy on Railway, not Fly.io\n" +
          "3. [memory]   Klio uses per-space embeddings (768/1024/1536)",
      },
    ],
    metadata: {
      space_id: "f11e05be-…",
      embedding_model: "ollama/nomic-embed-text",
      dim: 768,
      ranked_by: "cosine",
      total_ms: 4.2,
    },
  },
};

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
            gap: "3.5rem",
            alignItems: "center",
          }}
        >
          {/* Left column — editorial */}
          <div>
            <p className="k-eyebrow k-rise" data-stagger="1">
              <span style={{ color: "var(--klio-accent)" }}>●</span>
              <span style={{ marginLeft: "0.5rem" }}>
                memory layer · model context protocol
              </span>
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
              style={{ marginTop: "1.8rem" }}
            >
              Klio captures what your AI coding agents see, decide, and prefer —
              and serves it back through seven MCP tools. Claude Code in one
              window writes; Cursor in another instantly recalls. Encrypted,
              auditable, open-source.
            </p>

            <div
              className="k-rise"
              data-stagger="4"
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
                  letterSpacing: "0.04em",
                }}
              >
                v0.1.0 · open source · 0 telemetry
              </span>
            </div>
          </div>

          {/* Right column — calm paper card with a real MCP response */}
          <div className="k-rise" data-stagger="3" style={{ minWidth: 0 }}>
            <Frame
              path="POST /v1/spaces/{id}/recall"
              badge="MCP"
              footL={
                <>
                  <span style={{ color: "var(--klio-accent)" }}>●</span>{" "}
                  200 OK · 4.2 ms
                </>
              }
              footR="space:f11e05be · nomic-768"
            >
              <p
                style={{
                  marginBottom: "0.85rem",
                  color: "var(--klio-muted)",
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: "0.74rem",
                  fontStyle: "italic",
                }}
              >
                {`// what an agent receives back from klio-mcp`}
              </p>
              <div
                style={{
                  marginBottom: "0.65rem",
                  display: "flex",
                  gap: "0.5rem",
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: "0.78rem",
                }}
              >
                <span style={{ color: "var(--klio-faint)" }}>{">"}</span>
                <span style={{ color: "var(--klio-foreground)", fontWeight: 500 }}>
                  recall
                </span>
                <span style={{ color: "var(--klio-faint)" }}>{"({"}</span>
                <span className="k-tok-key">query</span>
                <span style={{ color: "var(--klio-faint)" }}>: </span>
                <span className="k-tok-str">
                  &quot;which JS runtime do I prefer?&quot;
                </span>
                <span style={{ color: "var(--klio-faint)" }}>{"})"}</span>
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: "0.78rem",
                  lineHeight: 1.65,
                  color: "var(--klio-foreground)",
                }}
              >
                <Json value={RECALL_RESPONSE} />
              </div>
            </Frame>
          </div>
        </div>
      </div>
    </section>
  );
}
