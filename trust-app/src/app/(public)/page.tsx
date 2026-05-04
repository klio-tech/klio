import { headers } from "next/headers";

import { HumanView } from "@/components/landing/HumanView";
import { MachineView } from "@/components/landing/MachineView";
import { ViewToggle } from "@/components/landing/ViewToggle";
import { detectViewMode } from "@/lib/view-mode";

/**
 * Klio public landing — dual-mode rendering.
 *
 * Server-side resolves the view mode from the URL query (?view=) and
 * the User-Agent (bot/agent UAs default to machine view). The chosen
 * DOM ships in the initial HTML, so a no-JS request still gets a
 * complete page in the right mode.
 *
 * The ViewToggle client component then lets a JS-enabled human flip
 * modes by replacing the URL query param.
 */
export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const params = await searchParams;
  const headerList = await headers();
  const userAgent = headerList.get("user-agent");
  const mode = detectViewMode(params.view, userAgent);

  return (
    <>
      {mode === "machine" ? <MachineView /> : <HumanView />}
      <ViewToggle initialMode={mode} />
    </>
  );
}
