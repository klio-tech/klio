/**
 * "Works with" bar — typographic only (no scraped logos), supadata-style.
 *
 * Each entry is a short wordmark in monospace, separated by a dot
 * spacer. We deliberately do NOT use real third-party logos because
 * (a) we don't have trademark licenses for them and (b) the
 * typographic treatment ages better than a logo grid that goes stale
 * the moment a vendor rebrands.
 *
 * Two rows:
 *   1. AI agents Klio wires up automatically (`klio init` patches
 *      each one's MCP config). This row answers the visitor's
 *      most-asked question: "will this work with the tool I use?".
 *   2. The stack Klio is built on. Lower-priority info, but useful
 *      for visitors comparing implementations.
 *
 * Splitting the rows mirrors how the data divides cognitively —
 * agent compatibility vs. internal stack — and keeps the eyebrow
 * labels honest.
 */

const AGENTS = [
  "claude code",
  "claude desktop",
  "cursor",
  "codex",
  "opencode",
  "openclaw",
];

const STACK = [
  "ollama",
  "openai",
  "anthropic",
  "postgres",
  "pgvector",
  "redis",
];

function MonoRow({ items }: { items: readonly string[] }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        rowGap: "0.6rem",
        flexWrap: "wrap",
        fontFamily: "var(--font-mono-stack)",
        fontSize: "0.85rem",
        color: "var(--klio-muted)",
      }}
    >
      {items.map((name, i) => (
        <span
          key={name}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "1rem",
          }}
        >
          <span>{name}</span>
          {i < items.length - 1 && (
            <span aria-hidden style={{ color: "var(--klio-faint)" }}>
              ·
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

function MonoSection({
  label,
  items,
}: {
  label: string;
  items: readonly string[];
}) {
  return (
    <div
      className="k-container"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "2.4rem",
        flexWrap: "wrap",
        justifyContent: "space-between",
      }}
    >
      <span className="k-eyebrow" style={{ flexShrink: 0 }}>
        {label}
      </span>
      <MonoRow items={items} />
    </div>
  );
}

export function TrustBar() {
  return (
    <section
      style={{
        paddingBlock: "2.5rem",
        borderTop: "1px solid var(--klio-border)",
        borderBottom: "1px solid var(--klio-border)",
        background: "var(--klio-paper)",
        display: "flex",
        flexDirection: "column",
        gap: "1.4rem",
      }}
    >
      <MonoSection label="works with" items={AGENTS} />
      <MonoSection label="built on" items={STACK} />
    </section>
  );
}
