/**
 * Flow — architecture diagram of how a memory moves through Klio,
 * from agent to disk and back. SVG so it scales cleanly; hand-drawn
 * with hairlines so it reads as a developer schematic, not a
 * marketing infographic.
 *
 * Two parallel rails:
 *   – TOP:    Claude Code (agent A) → klio-mcp → daemon → engine → disk
 *   – BOTTOM: Cursor (agent B) ← klio-mcp ← daemon ← engine ← disk
 *
 * The Redis pub/sub bus runs vertically between them, indicating
 * the cross-agent fan-out.
 */

export function Flow() {
  return (
    <section
      className="k-section"
      style={{ background: "var(--klio-paper)" }}
    >
      <div className="k-container">
        <header style={{ marginBottom: "3rem", maxWidth: "62ch" }}>
          <p className="k-eyebrow">data flow · your machine</p>
          <h2 className="k-h2" style={{ marginTop: "1rem" }}>
            What actually happens between agents.
          </h2>
          <p className="k-lede" style={{ marginTop: "1.2rem" }}>
            Every box below is a real process running on your laptop. The
            arrows are real socket / TCP connections. Nothing crosses the
            machine boundary unless you opt into Klio Cloud.
          </p>
        </header>

        <div
          style={{
            background: "var(--klio-background)",
            border: "1px solid var(--klio-border)",
            borderRadius: "0.65rem",
            padding: "2.5rem 1.5rem 2rem",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <FlowSVG />

          <div
            className="k-flow__caption"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "1.5rem",
              justifyContent: "center",
              marginTop: "2rem",
              fontSize: "0.7rem",
            }}
          >
            <LegendItem swatch="line">unix socket / stdio</LegendItem>
            <LegendItem swatch="dotted">redis pub/sub</LegendItem>
            <LegendItem swatch="accent">encrypted at rest</LegendItem>
            <LegendItem swatch="boundary">machine boundary</LegendItem>
          </div>
        </div>
      </div>
    </section>
  );
}

function LegendItem({
  swatch,
  children,
}: {
  swatch: "line" | "dotted" | "accent" | "boundary";
  children: React.ReactNode;
}) {
  const sw = (() => {
    if (swatch === "line")
      return (
        <span
          style={{
            display: "inline-block",
            width: "20px",
            height: "1px",
            background: "var(--klio-foreground)",
          }}
        />
      );
    if (swatch === "dotted")
      return (
        <span
          style={{
            display: "inline-block",
            width: "20px",
            height: "1px",
            backgroundImage:
              "linear-gradient(to right, var(--klio-accent) 50%, transparent 50%)",
            backgroundSize: "5px 1px",
            backgroundRepeat: "repeat-x",
          }}
        />
      );
    if (swatch === "accent")
      return (
        <span
          style={{
            display: "inline-block",
            width: "10px",
            height: "10px",
            background: "var(--klio-accent)",
            borderRadius: "2px",
          }}
        />
      );
    return (
      <span
        style={{
          display: "inline-block",
          width: "12px",
          height: "12px",
          border: "1px dashed var(--klio-border-strong)",
          background: "transparent",
        }}
      />
    );
  })();

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5rem",
        color: "var(--klio-muted)",
      }}
    >
      {sw}
      <span>{children}</span>
    </span>
  );
}

function FlowSVG() {
  return (
    <svg
      viewBox="0 0 1200 460"
      width="100%"
      height="auto"
      role="img"
      aria-label="Klio architecture: agents talk to klio-mcp, which talks to the bridge daemon, which talks to the engine, which uses Postgres, Redis, and Ollama."
      style={{ display: "block", maxWidth: "100%" }}
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="#0a0a0a" />
        </marker>
        <marker
          id="arrow-accent"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="#ff4500" />
        </marker>
      </defs>

      {/* Machine boundary */}
      <rect
        x="20"
        y="20"
        width="1160"
        height="420"
        rx="10"
        fill="none"
        stroke="#c8c5bc"
        strokeWidth="1"
        strokeDasharray="4 4"
      />
      <text
        x="44"
        y="44"
        fill="#a8a395"
        fontSize="11"
        fontFamily="var(--font-mono-stack)"
        letterSpacing="0.12em"
      >
        $HOME — your machine
      </text>

      {/* Agents column */}
      <Box x={70}  y={90}  w={170} h={56} title="Claude Code"  sub="MCP client + hooks" />
      <Box x={70}  y={170} w={170} h={56} title="Cursor"       sub="MCP client" />
      <Box x={70}  y={250} w={170} h={56} title="Codex"        sub="MCP client" />
      <text
        x={155} y={336}
        fill="#a8a395"
        fontSize="10"
        textAnchor="middle"
        fontFamily="var(--font-mono-stack)"
        letterSpacing="0.1em"
      >
        agents
      </text>

      {/* Arrow group: agents → klio-mcp */}
      <line x1="240" y1="118" x2="335" y2="118" stroke="#0a0a0a" strokeWidth="1" markerEnd="url(#arrow)" />
      <line x1="240" y1="198" x2="335" y2="198" stroke="#0a0a0a" strokeWidth="1" markerEnd="url(#arrow)" />
      <line x1="240" y1="278" x2="335" y2="278" stroke="#0a0a0a" strokeWidth="1" markerEnd="url(#arrow)" />
      <text x="288" y="105" fill="#6f6b62" fontSize="9" fontFamily="var(--font-mono-stack)" textAnchor="middle">stdio mcp</text>

      {/* klio-mcp shim — accented because it's the agent-facing surface */}
      <Box x={335} y={170} w={150} h={56} title="klio-mcp" sub="Apache 2.0 shim" accent />

      {/* mcp → daemon */}
      <line x1="485" y1="198" x2="580" y2="198" stroke="#0a0a0a" strokeWidth="1" markerEnd="url(#arrow)" />
      <text x="532" y="187" fill="#6f6b62" fontSize="9" fontFamily="var(--font-mono-stack)" textAnchor="middle">unix socket</text>

      {/* Bridge daemon */}
      <Box x={580} y={170} w={170} h={56} title="bridge daemon" sub="Go · keychain · cache" />

      {/* daemon → engine */}
      <line x1="750" y1="198" x2="855" y2="198" stroke="#0a0a0a" strokeWidth="1" markerEnd="url(#arrow)" />
      <text x="802" y="187" fill="#6f6b62" fontSize="9" fontFamily="var(--font-mono-stack)" textAnchor="middle">https + JWT</text>

      {/* Engine */}
      <Box x={855} y={170} w={180} h={56} title="engine" sub="Python · FastAPI" />

      {/* Engine → infra (Postgres, Redis, Ollama) */}
      <Box x={1035} y={90}  w={130} h={56} title="Postgres"  sub="pgvector · KMS" small />
      <Box x={1035} y={170} w={130} h={56} title="Redis"     sub="pub/sub" small />
      <Box x={1035} y={250} w={130} h={56} title="Ollama"    sub="embed + extract" small />

      <line x1="1035" y1="118" x2="1015" y2="118" stroke="#0a0a0a" strokeWidth="1" markerEnd="url(#arrow)" />
      <line x1="1015" y1="118" x2="1015" y2="186" stroke="#0a0a0a" strokeWidth="1" />
      <line x1="1015" y1="198" x2="1035" y2="198" stroke="#0a0a0a" strokeWidth="1" markerEnd="url(#arrow)" />
      <line x1="1035" y1="278" x2="1015" y2="278" stroke="#0a0a0a" strokeWidth="1" markerEnd="url(#arrow)" />
      <line x1="1015" y1="278" x2="1015" y2="210" stroke="#0a0a0a" strokeWidth="1" />

      {/* Pub/sub fan-out from Redis back to other daemons */}
      <path
        d="M 1100 226 Q 1100 380 600 380 Q 240 380 240 230"
        fill="none"
        stroke="#ff4500"
        strokeWidth="1"
        strokeDasharray="5 4"
        markerEnd="url(#arrow-accent)"
      />
      <text
        x="660" y="404"
        fill="#ff4500"
        fontSize="10"
        textAnchor="middle"
        fontFamily="var(--font-mono-stack)"
        letterSpacing="0.04em"
      >
        space:&lt;id&gt; → frame.entry.created → all subscribed agents
      </text>

      {/* Encrypted-at-rest indicator */}
      <rect
        x={1041}
        y={96}
        width={6}
        height={44}
        fill="#ff4500"
      />
    </svg>
  );
}

/** A box in the architecture diagram. */
function Box({
  x,
  y,
  w,
  h,
  title,
  sub,
  small,
  accent,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub: string;
  small?: boolean;
  accent?: boolean;
}) {
  void small;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={5}
        fill="#fafaf7"
        stroke={accent ? "#ff4500" : "#0a0a0a"}
        strokeWidth={accent ? 1.4 : 1}
      />
      <text
        x={x + 12}
        y={y + 21}
        fill="#0a0a0a"
        fontFamily="var(--font-sans-stack)"
        fontSize="13"
        fontWeight={500}
      >
        {title}
      </text>
      <text
        x={x + 12}
        y={y + 39}
        fill="#6f6b62"
        fontFamily="var(--font-mono-stack)"
        fontSize="10"
        letterSpacing="0.04em"
      >
        {sub}
      </text>
    </g>
  );
}
