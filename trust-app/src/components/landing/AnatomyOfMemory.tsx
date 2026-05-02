import { Frame } from "./Frame";
import { Json } from "./Json";

/**
 * "Anatomy of a memory" — replaces the prose Features grid with a
 * single concrete artifact viewed through six lenses.
 *
 * The same entry is shown as: plaintext, ciphertext, embedding,
 * audit hash, metadata, and the wire frame an agent receives. The
 * point is total transparency — Klio doesn't ask you to take its
 * security/auditability claims on faith. Every layer is inspectable.
 */

const ENTRY_ID = "8fc8f94a-7901-490a-8c9e-44dc1824384d";
const PREV_HASH = "9b2c…f4d1";
const THIS_HASH = "a3f1…00bc";
const NEXT_HASH = "c47e…91a8";

const SAMPLE_VECTOR = [
  0.0427, -0.0832, 0.1149, 0.0210, -0.0944, 0.1832, -0.0566, 0.0029,
  -0.1207, 0.0418, 0.0905, -0.0314, -0.0782, 0.1361, 0.0073, -0.0492,
];

const SAMPLE_CIPHERTEXT =
  "5f 8a c1 4e 2b 90 d7 11  7c 0a 39 8e 4f a2 c8 12  " +
  "3d 5b 6e 9c f0 41 25 70  88 b3 47 16 d2 f9 0b 5e";

const WIRE_FRAME = {
  type: "entry.created",
  space_id: "f11e05be-e340-4073-a08d-3854f8fe49d1",
  frame_id: "d2e1088e-7c91-4a23-b8de-5fa20c1ed934",
  entry: {
    id: ENTRY_ID,
    kind: "memory",
    agent_id: "7fa9ca2d-539a-4a6a-a9c5-e7e2d2bde494",
    confidence: 1.0,
    created_at: "2026-05-02T18:11:52.754Z",
  },
};

export function AnatomyOfMemory() {
  return (
    <section className="k-section">
      <div className="k-container">
        {/* Section header */}
        <header style={{ marginBottom: "3rem", maxWidth: "62ch" }}>
          <p className="k-eyebrow">anatomy of a memory</p>
          <h2 className="k-h2" style={{ marginTop: "1rem" }}>
            One entry, six lenses.
          </h2>
          <p className="k-lede" style={{ marginTop: "1.2rem" }}>
            Klio doesn&apos;t ask you to trust the security claims. Every layer
            is inspectable — by you, by an auditor, by the agent. Below is
            the same memory, written once, viewed six ways.
          </p>
        </header>

        <div className="k-anatomy-grid">
          {/* Hero lens — the plaintext */}
          <div className="k-anatomy-grid__hero">
            <Frame
              path="entry.id = 8fc8f94a-7901-490a-8c9e-44dc1824384d"
              badge="memory"
              footL="kind=memory · confidence=1.0"
              footR="space:default · agent:7fa9ca2d…"
            >
              <p
                className="k-lens-label"
                style={{ marginBottom: "0.7rem" }}
              >
                <span className="k-lens-label__num">01</span>{" "}
                plaintext · what you wrote
              </p>
              <div
                style={{
                  fontFamily: "var(--font-serif-stack)",
                  fontSize: "1.6rem",
                  lineHeight: 1.35,
                  color: "var(--klio-foreground)",
                  letterSpacing: "-0.012em",
                  fontStyle: "italic",
                }}
              >
                &ldquo;User prefers Bun runtime over Node and npm for
                JavaScript projects.&rdquo;
              </div>
              <p
                style={{
                  marginTop: "0.8rem",
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: "0.72rem",
                  color: "var(--klio-muted)",
                }}
              >
                — written via{" "}
                <code style={{ color: "var(--klio-accent)" }}>
                  mcp__klio__remember
                </code>{" "}
                from a Claude Code session, May 2 · 18:11 UTC
              </p>
            </Frame>
          </div>

          {/* Lens 2 — encrypted ciphertext */}
          <Frame
            path="entries.content_ciphertext"
            badge="AES-256-GCM"
          >
            <p className="k-lens-label" style={{ marginBottom: "0.7rem" }}>
              <span className="k-lens-label__num">02</span> ciphertext · what&apos;s on disk
            </p>
            <div
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.72rem",
                lineHeight: 1.7,
                color: "var(--klio-muted)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {SAMPLE_CIPHERTEXT}
              <br />
              <span style={{ color: "var(--klio-faint)" }}>… 98 more bytes</span>
            </div>
            <p
              style={{
                marginTop: "0.8rem",
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.72rem",
                color: "var(--klio-muted)",
              }}
            >
              sealed under your envelope key, wrapped by{" "}
              <code style={{ color: "var(--klio-accent)" }}>~/.klio/dev-kms.key</code>
            </p>
          </Frame>

          {/* Lens 3 — embedding */}
          <Frame
            path="entry_embeddings_768.embedding"
            badge="768d · nomic"
          >
            <p className="k-lens-label" style={{ marginBottom: "0.7rem" }}>
              <span className="k-lens-label__num">03</span> embedding · how recall finds it
            </p>
            <div
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.74rem",
                lineHeight: 1.7,
                color: "var(--klio-muted)",
              }}
            >
              <span className="k-tok-punct">[</span>
              {SAMPLE_VECTOR.map((n, i) => (
                <span key={i}>
                  <span className="k-tok-num">{n.toFixed(4)}</span>
                  {i < SAMPLE_VECTOR.length - 1 && (
                    <span className="k-tok-punct">, </span>
                  )}
                </span>
              ))}
              <span className="k-tok-punct">,&nbsp;</span>
              <span style={{ color: "var(--klio-faint)" }}>… 752 more</span>
              <span className="k-tok-punct">]</span>
            </div>
            <p
              style={{
                marginTop: "0.8rem",
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.72rem",
                color: "var(--klio-muted)",
              }}
            >
              cosine-indexed by pgvector HNSW; switchable per-space via{" "}
              <code style={{ color: "var(--klio-accent)" }}>klio reembed</code>
            </p>
          </Frame>

          {/* Lens 4 — hash chain */}
          <Frame
            path="audit_log.hash"
            badge="SHA-256"
          >
            <p className="k-lens-label" style={{ marginBottom: "0.9rem" }}>
              <span className="k-lens-label__num">04</span> chain · tamper-evident provenance
            </p>
            <div
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.78rem",
                lineHeight: 1.85,
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                columnGap: "1rem",
                rowGap: "0.05rem",
              }}
            >
              <span style={{ color: "var(--klio-faint)" }}>prev</span>
              <code style={{ color: "var(--klio-muted)" }}>{PREV_HASH}</code>
              <span style={{ color: "var(--klio-accent)" }}>this</span>
              <code style={{ color: "var(--klio-foreground)", fontWeight: 500 }}>
                {THIS_HASH}
              </code>
              <span style={{ color: "var(--klio-faint)" }}>next</span>
              <code style={{ color: "var(--klio-muted)" }}>{NEXT_HASH}</code>
            </div>
            <p
              style={{
                marginTop: "0.9rem",
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.72rem",
                color: "var(--klio-muted)",
              }}
            >
              hourly root → OpenTimestamps → Bitcoin
            </p>
          </Frame>

          {/* Lens 5 — metadata */}
          <Frame
            path="SELECT * FROM entries WHERE id = …"
            badge="postgres"
          >
            <p className="k-lens-label" style={{ marginBottom: "0.9rem" }}>
              <span className="k-lens-label__num">05</span> metadata · joins, audits, ACL
            </p>
            <div
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.78rem",
                lineHeight: 1.85,
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                columnGap: "1rem",
                rowGap: "0.05rem",
                color: "var(--klio-foreground)",
              }}
            >
              <span style={{ color: "var(--klio-faint)" }}>id</span>
              <code style={{ color: "var(--klio-muted)" }}>8fc8f94a…</code>
              <span style={{ color: "var(--klio-faint)" }}>kind</span>
              <code>memory</code>
              <span style={{ color: "var(--klio-faint)" }}>user</span>
              <code style={{ color: "var(--klio-muted)" }}>0311adba…</code>
              <span style={{ color: "var(--klio-faint)" }}>agent</span>
              <code style={{ color: "var(--klio-muted)" }}>7fa9ca2d…</code>
              <span style={{ color: "var(--klio-faint)" }}>space</span>
              <code style={{ color: "var(--klio-muted)" }}>default</code>
              <span style={{ color: "var(--klio-faint)" }}>created</span>
              <code style={{ color: "var(--klio-muted)" }}>2026-05-02T18:11:52Z</code>
              <span style={{ color: "var(--klio-faint)" }}>confidence</span>
              <code style={{ color: "var(--klio-muted)" }}>1.0</code>
            </div>
          </Frame>

          {/* Lens 6 — wire frame */}
          <Frame
            path="redis pub channel: space:f11e05be…"
            badge="frame"
          >
            <p className="k-lens-label" style={{ marginBottom: "0.7rem" }}>
              <span className="k-lens-label__num">06</span> wire · what other agents receive
            </p>
            <div
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.74rem",
                lineHeight: 1.6,
                color: "var(--klio-foreground)",
              }}
            >
              <Json value={WIRE_FRAME} />
            </div>
            <p
              style={{
                marginTop: "0.6rem",
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.72rem",
                color: "var(--klio-muted)",
              }}
            >
              fanned out via Redis pub/sub in 1-3 ms
            </p>
          </Frame>
        </div>
      </div>
    </section>
  );
}
