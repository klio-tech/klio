/**
 * "Anatomy of a memory" — six lenses on a single concrete artifact,
 * laid out as editorial chapters. Big serif numerals on the left
 * margin, eyebrow + content stack on the right, hairline rules
 * between lenses. Like reading numbered passages in a typography-
 * conscious book — no IDE/terminal chrome, the typography is the
 * container.
 */

import type { ReactNode } from "react";

const SAMPLE_VECTOR = [
  0.0427, -0.0832, 0.1149, 0.0210, -0.0944, 0.1832, -0.0566, 0.0029,
  -0.1207, 0.0418, 0.0905, -0.0314, -0.0782, 0.1361, 0.0073, -0.0492,
];

const SAMPLE_CIPHERTEXT =
  "5f 8a c1 4e 2b 90 d7 11  7c 0a 39 8e 4f a2 c8 12  " +
  "3d 5b 6e 9c f0 41 25 70  88 b3 47 16 d2 f9 0b 5e";

export function AnatomyOfMemory() {
  return (
    <section className="k-section">
      <div className="k-container">
        {/* Section header */}
        <header style={{ marginBottom: "4.5rem", maxWidth: "62ch" }}>
          <p className="k-eyebrow">anatomy of a memory</p>
          <h2 className="k-h2" style={{ marginTop: "1rem" }}>
            One entry, six lenses.
          </h2>
          <p className="k-lede" style={{ marginTop: "1.2rem" }}>
            Klio doesn&apos;t ask you to trust the security claims. Every
            layer is inspectable — by you, by an auditor, by the agent
            itself. The same memory below, written once, viewed six
            ways.
          </p>
        </header>

        <div>
          <Chapter num="01" eyebrow="plaintext · what you wrote" caption="written via mcp__klio__remember from a Claude Code session, May 2 · 18:11 UTC">
            <p
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontWeight: 600,
                fontSize: "1.4rem",
                lineHeight: 1.3,
                color: "var(--klio-foreground)",
                letterSpacing: "-0.012em",
                maxWidth: "34ch",
              }}
            >
              &ldquo;User prefers Bun runtime over Node and npm for
              JavaScript projects.&rdquo;
            </p>
          </Chapter>

          <Chapter num="02" eyebrow="ciphertext · what's actually on disk" caption="sealed under your envelope key, wrapped by ~/.klio/dev-kms.key (mode 0600)">
            <div
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.84rem",
                lineHeight: 1.7,
                color: "var(--klio-foreground)",
                letterSpacing: "0.04em",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {SAMPLE_CIPHERTEXT}
              <br />
              <span style={{ color: "var(--klio-faint)" }}>… 98 more bytes</span>
            </div>
          </Chapter>

          <Chapter num="03" eyebrow="embedding · how recall finds it" caption="cosine-indexed via pgvector HNSW · switchable per-space with klio reembed">
            <div
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.86rem",
                lineHeight: 1.7,
                color: "var(--klio-foreground)",
              }}
            >
              [{" "}
              {SAMPLE_VECTOR.map((n, i) => (
                <span key={i}>
                  <span>{n.toFixed(4)}</span>
                  {i < SAMPLE_VECTOR.length - 1 && (
                    <span style={{ color: "var(--klio-faint)" }}>, </span>
                  )}
                </span>
              ))}
              <span style={{ color: "var(--klio-faint)" }}>, … 752 more</span>
              {" "}]
            </div>
          </Chapter>

          <Chapter num="04" eyebrow="chain · tamper-evident provenance" caption="hourly root → OpenTimestamps → Bitcoin">
            <div
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontSize: "1rem",
                lineHeight: 2,
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                columnGap: "1.5rem",
              }}
            >
              <span style={{ color: "var(--klio-faint)" }}>prev</span>
              <code style={{ color: "var(--klio-muted)" }}>9b2c…f4d1</code>
              <span
                style={{
                  fontFamily: "var(--font-mono-stack)",
                  fontWeight: 700,
                  color: "var(--klio-foreground)",
                  fontSize: "1rem",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
              >
                this
              </span>
              <code
                style={{
                  color: "var(--klio-foreground)",
                  fontWeight: 600,
                }}
              >
                a3f1…00bc
              </code>
              <span style={{ color: "var(--klio-faint)" }}>next</span>
              <code style={{ color: "var(--klio-muted)" }}>c47e…91a8</code>
            </div>
          </Chapter>

          <Chapter num="05" eyebrow="metadata · joins, audits, ACL" caption="row in entries table; one of 8 columns visible">
            <div
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.92rem",
                lineHeight: 1.85,
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                columnGap: "1.5rem",
                color: "var(--klio-foreground)",
              }}
            >
              <span style={{ color: "var(--klio-faint)" }}>id</span>
              <code style={{ color: "var(--klio-muted)" }}>8fc8f94a-7901-490a-8c9e-44dc1824384d</code>
              <span style={{ color: "var(--klio-faint)" }}>kind</span>
              <code>memory</code>
              <span style={{ color: "var(--klio-faint)" }}>user</span>
              <code style={{ color: "var(--klio-muted)" }}>0311adba-2cf9-4caf-…</code>
              <span style={{ color: "var(--klio-faint)" }}>agent</span>
              <code style={{ color: "var(--klio-muted)" }}>7fa9ca2d-539a-4a6a-…</code>
              <span style={{ color: "var(--klio-faint)" }}>space</span>
              <code style={{ color: "var(--klio-muted)" }}>default</code>
              <span style={{ color: "var(--klio-faint)" }}>created</span>
              <code style={{ color: "var(--klio-muted)" }}>2026-05-02 T 18:11:52 Z</code>
              <span style={{ color: "var(--klio-faint)" }}>confidence</span>
              <code style={{ color: "var(--klio-muted)" }}>1.0</code>
            </div>
          </Chapter>

          <Chapter num="06" eyebrow="wire · what other agents receive" caption="fanned out via Redis pub/sub on space:&lt;id&gt; in 1–3 ms" last>
            <div
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.86rem",
                lineHeight: 1.7,
                color: "var(--klio-foreground)",
              }}
            >
              {`{`}
              <br />
              {"  "}<span style={{ color: "var(--klio-muted)" }}>type</span>:{" "}
              <span style={{ color: "var(--klio-muted)" }}>&quot;entry.created&quot;</span>,
              <br />
              {"  "}<span style={{ color: "var(--klio-muted)" }}>space_id</span>:{" "}
              <span style={{ color: "var(--klio-muted)" }}>&quot;f11e05be…&quot;</span>,
              <br />
              {"  "}<span style={{ color: "var(--klio-muted)" }}>frame_id</span>:{" "}
              <span style={{ color: "var(--klio-muted)" }}>&quot;d2e1088e…&quot;</span>,
              <br />
              {"  "}<span style={{ color: "var(--klio-muted)" }}>entry</span>: {`{`}
              <br />
              {"    "}<span style={{ color: "var(--klio-muted)" }}>id</span>:{" "}
              <span style={{ color: "var(--klio-muted)" }}>&quot;8fc8f94a-7901-…&quot;</span>,
              <br />
              {"    "}<span style={{ color: "var(--klio-muted)" }}>kind</span>:{" "}
              <span style={{ color: "var(--klio-muted)" }}>&quot;memory&quot;</span>,
              <br />
              {"    "}<span style={{ color: "var(--klio-muted)" }}>created_at</span>:{" "}
              <span style={{ color: "var(--klio-muted)" }}>
                &quot;2026-05-02T18:11:52Z&quot;
              </span>
              <br />
              {"  "}{`}`}
              <br />
              {`}`}
            </div>
          </Chapter>
        </div>
      </div>
    </section>
  );
}

/**
 * One numbered chapter — big serif numeral on the left, eyebrow +
 * content + caption stack on the right, hairline rule above (and
 * below the last one).
 */
function Chapter({
  num,
  eyebrow,
  caption,
  last,
  children,
}: {
  num: string;
  eyebrow: string;
  caption: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <article
      className="anatomy-chapter"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(110px, 0.16fr) minmax(0, 1fr)",
        columnGap: "2.4rem",
        paddingBlock: "3rem",
        borderTop: "1px solid var(--klio-foreground)",
        borderBottom: last ? "1px solid var(--klio-foreground)" : "0",
      }}
    >
      <div>
        <div
          style={{
            fontFamily: "var(--font-mono-stack)",
            fontWeight: 700,
            fontSize: "clamp(2.4rem, 4.4vw, 3.6rem)",
            lineHeight: 0.95,
            letterSpacing: "-0.03em",
            color: "var(--klio-foreground)",
          }}
        >
          {num}
        </div>
      </div>
      <div>
        <p className="k-eyebrow" style={{ marginBottom: "1.4rem" }}>
          {eyebrow}
        </p>
        {children}
        <p
          style={{
            marginTop: "1.4rem",
            fontFamily: "var(--font-mono-stack)",
            fontSize: "0.74rem",
            color: "var(--klio-muted)",
            maxWidth: "60ch",
          }}
        >
          {caption}
        </p>
      </div>
    </article>
  );
}
