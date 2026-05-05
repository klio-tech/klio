"use client";

/**
 * Google Analytics (gtag.js) — klio.tech public landing only.
 *
 * Lives ONLY inside the `(public)` route group, which is FS-renamed
 * to `__klio_hidden_public__` in the local build by
 * scripts/select-target.mjs. This guarantees the GA snippet never
 * ships to laptops running the dashboard locally — Klio is
 * local-first, and the dashboard must never phone home. The
 * scripts/check-bundle-isolation.mjs guardrail also forbids the
 * strings `PublicAnalytics` and `googletagmanager` from appearing in
 * the local runtime bundle, so a future regression that imports this
 * file into a shared path fails CI loudly.
 *
 * Loaded via next/script with strategy="afterInteractive" so it
 * runs after hydration and never blocks paint. Skipped when
 * NODE_ENV !== "production" so dev / preview / build traffic
 * doesn't pollute production analytics.
 *
 * The measurement ID falls back to the canonical klio.tech property
 * (`G-KVM1QZQ9JL`) so a fresh Railway deploy works with zero env
 * config; an operator can override with `NEXT_PUBLIC_GA_MEASUREMENT_ID`
 * for staging or per-environment splits.
 */

import Script from "next/script";

const DEFAULT_MEASUREMENT_ID = "G-KVM1QZQ9JL";

const MEASUREMENT_ID =
  process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || DEFAULT_MEASUREMENT_ID;

export function PublicAnalytics() {
  // Production-only: dev runs and preview deploys must not feed GA.
  // Next inlines NODE_ENV at build time, so this branch is dead-code
  // eliminated from prod bundles.
  if (process.env.NODE_ENV !== "production") return null;
  if (!MEASUREMENT_ID) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`}
        strategy="afterInteractive"
      />
      <Script id="ga-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${MEASUREMENT_ID}');
        `}
      </Script>
    </>
  );
}
