import Link from "next/link";

import { getSession } from "@/lib/session";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  return (
    <>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.75rem 2rem",
          borderBottom: "1px solid var(--klio-border)",
          marginBottom: "1.5rem",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <Link
          href="/"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "1rem",
            fontWeight: 500,
            letterSpacing: "-0.01em",
            textDecoration: "none",
            color: "var(--klio-foreground)",
          }}
        >
          klio<span style={{ color: "var(--klio-accent)" }}>.</span>
        </Link>
        <nav style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", fontSize: "0.9rem" }}>
          {session ? (
            <>
              <Link href="/memories">Memories</Link>
              <Link href="/spaces">Spaces</Link>
              <Link href="/access-requests">Access requests</Link>
              <Link href="/security">Security</Link>
            </>
          ) : (
            <Link href="/security">Security</Link>
          )}
        </nav>
      </header>
      <div
        style={{
          padding: "0 2rem 3rem",
          maxWidth: "960px",
          margin: "0 auto",
        }}
      >
        {children}
      </div>
    </>
  );
}
