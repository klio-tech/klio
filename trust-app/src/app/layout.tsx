import type { Metadata } from "next";
import Link from "next/link";

import { getSession } from "@/lib/session";

import "./globals.css";

export const metadata: Metadata = {
  title: "Klio — your AI agents, finally talking to each other",
  description: "See and control everything Klio remembers about you.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  return (
    <html lang="en">
      <body>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.75rem 2rem",
            borderBottom: "1px solid var(--muted)",
            marginBottom: "1.5rem",
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <Link
            href="/"
            style={{ fontWeight: 700, fontSize: "1.1rem", textDecoration: "none" }}
          >
            Klio
          </Link>
          <nav
            style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}
          >
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
        <div style={{ padding: "0 2rem 3rem", maxWidth: "960px", margin: "0 auto" }}>
          {children}
        </div>
      </body>
    </html>
  );
}
