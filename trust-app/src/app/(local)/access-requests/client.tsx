"use client";

import { useTransition } from "react";

export function DecideButtons({
  requestId,
  action,
}: {
  requestId: string;
  action: (requestId: string, decision: "approve" | "deny") => Promise<void>;
}) {
  const [isPending, startTransition] = useTransition();

  function decide(decision: "approve" | "deny") {
    startTransition(async () => {
      await action(requestId, decision);
    });
  }

  return (
    <div style={{ display: "flex", gap: "0.5rem" }}>
      <button onClick={() => decide("approve")} disabled={isPending}>
        Approve
      </button>
      <button
        className="secondary"
        onClick={() => decide("deny")}
        disabled={isPending}
      >
        Deny
      </button>
    </div>
  );
}
