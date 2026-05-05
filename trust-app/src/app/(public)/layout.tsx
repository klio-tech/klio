/**
 * Layout for the `(public)` route group — klio.tech.
 *
 * Wraps every public route (`/`, `/security`, `/verify`) with the
 * Google Analytics snippet via PublicAnalytics. Because the FS
 * router renames the entire `(public)/` group out of the local build
 * (see scripts/select-target.mjs), this layout — and its analytics
 * payload — only ship in the public production build that powers
 * klio.tech. The local dashboard build never sees it.
 *
 * No additional UI chrome here: the existing root layout
 * (src/app/layout.tsx) already provides the html/body shell and
 * font setup. This layout exists purely to attach analytics to the
 * public sub-tree.
 */

import { PublicAnalytics } from "@/components/landing/PublicAnalytics";

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {children}
      <PublicAnalytics />
    </>
  );
}
