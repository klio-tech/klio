"use client";

import { useState, useTransition, type FormEvent } from "react";

import type { Entry, EntryKind } from "@/lib/api";

import { runRecall, type RecallResult } from "./actions";

const KINDS: (EntryKind | "all")[] = [
  "all",
  "memory",
  "observation",
  "plan",
  "decision",
  "note",
];

export function SearchForm({ spaceId }: { spaceId: string }) {
  const [results, setResults] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("all");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setError(null);
    startTransition(async () => {
      try {
        const res: RecallResult = await runRecall({
          spaceId,
          query: query.trim(),
          kind: kind === "all" ? undefined : kind,
        });
        setResults(res.entries);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <section style={{ marginBottom: "2rem" }}>
      <h2 style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>
        Semantic search
      </h2>
      <p className="muted" style={{ marginBottom: "0.75rem" }}>
        Embeds your query with the same model your space uses, ranks every
        entry by cosine similarity, returns the top 20.
      </p>
      <form
        onSubmit={onSubmit}
        style={{
          display: "flex",
          gap: "0.5rem",
          alignItems: "stretch",
          flexWrap: "wrap",
        }}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. which JavaScript runtime do I prefer"
          style={{
            flex: "1 1 320px",
            padding: "0.5rem 0.75rem",
            borderRadius: "0.375rem",
            border: "1px solid var(--muted)",
            fontFamily: "inherit",
          }}
          required
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
          style={{
            padding: "0.5rem 0.75rem",
            borderRadius: "0.375rem",
            border: "1px solid var(--muted)",
          }}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={pending}
          style={{
            padding: "0.5rem 1rem",
            borderRadius: "0.375rem",
            border: "none",
            background: "var(--foreground)",
            color: "var(--background)",
            fontWeight: 500,
            cursor: pending ? "wait" : "pointer",
          }}
        >
          {pending ? "Searching…" : "Recall"}
        </button>
      </form>
      {error && (
        <p style={{ color: "#c00", marginTop: "0.5rem" }}>Error: {error}</p>
      )}
      {results !== null && (
        <div style={{ marginTop: "1rem" }}>
          <p className="muted">
            {results.length} match{results.length === 1 ? "" : "es"} for
            “{query}”
          </p>
          <ul className="list" style={{ listStyle: "none" }}>
            {results.map((e) => (
              <li key={e.id} className="list-item" style={{ display: "block" }}>
                <div style={{ marginBottom: "0.25rem" }}>
                  <span
                    style={{
                      fontSize: "0.75rem",
                      padding: "0.125rem 0.5rem",
                      borderRadius: "0.25rem",
                      background: "var(--muted)",
                      marginRight: "0.5rem",
                    }}
                  >
                    {e.kind}
                  </span>
                  <span className="muted" style={{ fontSize: "0.85rem" }}>
                    {new Date(e.created_at).toLocaleString()}
                  </span>
                </div>
                <div>{e.content}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
