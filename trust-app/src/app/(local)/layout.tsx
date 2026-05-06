import Link from "next/link";

import { getSession } from "@/lib/session";
import { fetchBanners } from "@/lib/system-banners";
import { KlioMark } from "@/components/landing/KlioMark";
import { ClaimEmailBanner } from "@/components/banners/ClaimEmailBanner";

// Engine base URL — matches the resolution used elsewhere in
// trust-app (see src/lib/api.ts). Kept in lockstep with that file.
const ENGINE_URL = process.env.KLIO_ENGINE_URL ?? "http://127.0.0.1:8000";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  // Banner data is fetched server-side so the initial HTML already
  // includes the (small) banner markup — no client-side flash. We
  // expose the engine URL to the banner so its in-banner POST to
  // /v1/auth/login-link reaches the same engine the layout queried.
  const banners = session
    ? await fetchBanners(ENGINE_URL, session.accessToken)
    : [];
  const claimEmailBanner = banners.find((b) => b.kind === "claim_email");
  return (
    <>
      {claimEmailBanner && (
        <ClaimEmailBanner banner={claimEmailBanner} engineURL={ENGINE_URL} />
      )}
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
            display: "inline-flex",
            alignItems: "center",
            gap: "0.65rem",
            textDecoration: "none",
            color: "var(--klio-foreground)",
          }}
        >
          <KlioMark size={28} />
          <span
            style={{
              fontFamily: "var(--font-mono-stack)",
              fontSize: "1.25rem",
              fontWeight: 700,
              letterSpacing: "-0.01em",
              lineHeight: 1,
            }}
          >
            klio
          </span>
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
