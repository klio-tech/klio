"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import type { ViewMode } from "@/lib/view-mode";

/**
 * Bottom-right pill toggle that flips between the human marketing
 * view and the machine-readable view. Persists state via the URL
 * (?view=human|machine) so the choice is bookmarkable and
 * server-respected on the next request.
 *
 * The current state is supplied by the server (which already
 * resolved it from the URL + User-Agent) so this component never
 * needs to re-detect it on the client.
 */
export function ViewToggle({ initialMode }: { initialMode: ViewMode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function setMode(target: ViewMode) {
    if (target === initialMode) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", target);
    startTransition(() => {
      router.replace(`/?${params.toString()}`, { scroll: false });
    });
  }

  return (
    <div
      role="radiogroup"
      aria-label="Page view mode"
      className={`k-toggle ${isPending ? "k-toggle--pending" : ""}`.trim()}
    >
      <button
        type="button"
        role="radio"
        aria-checked={initialMode === "human"}
        onClick={() => setMode("human")}
        className={`k-toggle__btn ${
          initialMode === "human" ? "k-toggle__btn--active" : ""
        }`.trim()}
      >
        <span aria-hidden className="k-toggle__dot" />
        HUMAN
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={initialMode === "machine"}
        onClick={() => setMode("machine")}
        className={`k-toggle__btn ${
          initialMode === "machine" ? "k-toggle__btn--active" : ""
        }`.trim()}
      >
        <span aria-hidden className="k-toggle__dot" />
        MACHINE
      </button>
    </div>
  );
}
