import Link from "next/link";

import { KlioMark } from "./KlioMark";

const LINKS = [
  { label: "Docs", href: "https://github.com/klio-tech/klio#readme" },
  { label: "GitHub", href: "https://github.com/klio-tech/klio" },
  { label: "Cloud", href: "/?view=human#waitlist" },
];

export function LandingHeader() {
  return (
    <header
      style={{
        position: "relative",
        zIndex: 4,
        paddingBlock: "1.4rem",
        borderBottom: "1px solid var(--klio-border)",
      }}
    >
      <div
        className="k-container"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <Link
          href="/"
          aria-label="Klio home"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.55rem",
            color: "var(--klio-foreground)",
          }}
        >
          <KlioMark size={22} />
          <span
            style={{
              fontFamily: "var(--font-mono-stack)",
              fontSize: "1.02rem",
              fontWeight: 500,
              letterSpacing: "-0.005em",
            }}
          >
            klio
          </span>
        </Link>

        <nav
          style={{
            display: "flex",
            alignItems: "center",
            gap: "1.4rem",
            fontFamily: "var(--font-mono-stack)",
            fontSize: "0.88rem",
          }}
        >
          {LINKS.map((l) => {
            const external = l.href.startsWith("http");
            return external ? (
              <a
                key={l.label}
                href={l.href}
                target="_blank"
                rel="noreferrer"
                className="k-link"
              >
                {l.label}
              </a>
            ) : (
              <Link key={l.label} href={l.href} className="k-link">
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
