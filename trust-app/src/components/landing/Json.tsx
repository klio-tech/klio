import type { ReactNode } from "react";

/**
 * Tiny JSON pretty-printer with semantic syntax colours.
 *
 * No JS library — just type-walk the value and emit <span> elements
 * with `k-tok-*` classes (defined in globals.css). Saves ~30kB of
 * highlighter bundle and lets us style consistently across both
 * the dark hero frame and the paper-variant lens cards.
 */
export function Json({
  value,
  indent = 2,
  prefix = "",
}: {
  value: unknown;
  indent?: number;
  prefix?: string;
}) {
  return (
    <pre
      style={{
        margin: 0,
        fontFamily: "inherit",
        fontSize: "inherit",
        lineHeight: "inherit",
        whiteSpace: "pre",
      }}
    >
      {render(value, indent, "", prefix)}
    </pre>
  );
}

function render(
  v: unknown,
  indent: number,
  pad: string,
  prefix: string,
): ReactNode {
  if (v === null) return <span className="k-tok-null">null</span>;
  if (typeof v === "boolean") return <span className="k-tok-bool">{String(v)}</span>;
  if (typeof v === "number") return <span className="k-tok-num">{v}</span>;
  if (typeof v === "string") return <span className="k-tok-str">{JSON.stringify(v)}</span>;

  const ind = " ".repeat(indent);
  const inner = pad + ind;

  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="k-tok-punct">[]</span>;
    return (
      <>
        <span className="k-tok-punct">[</span>
        {"\n"}
        {v.map((item, i) => (
          <span key={i}>
            {inner}
            {render(item, indent, inner, prefix)}
            {i < v.length - 1 && <span className="k-tok-punct">,</span>}
            {"\n"}
          </span>
        ))}
        {pad}
        <span className="k-tok-punct">]</span>
      </>
    );
  }

  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return <span className="k-tok-punct">{"{}"}</span>;
    return (
      <>
        <span className="k-tok-punct">{"{"}</span>
        {"\n"}
        {entries.map(([k, val], i) => (
          <span key={k}>
            {inner}
            <span className="k-tok-key">"{k}"</span>
            <span className="k-tok-punct">: </span>
            {render(val, indent, inner, prefix)}
            {i < entries.length - 1 && <span className="k-tok-punct">,</span>}
            {"\n"}
          </span>
        ))}
        {pad}
        <span className="k-tok-punct">{"}"}</span>
      </>
    );
  }

  return <span>{String(v)}</span>;
}
