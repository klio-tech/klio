import Link from "next/link";

import { api, type Entry, type EntryKind } from "@/lib/api";

import { SearchForm } from "./search-form";

const KINDS: (EntryKind | "all")[] = [
  "all",
  "memory",
  "observation",
  "plan",
  "decision",
  "note",
];

export const dynamic = "force-dynamic";

type Search = {
  space?: string;
  kind?: string;
  limit?: string;
};

export default async function MemoriesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const spaces = await api.listSpaces();
  if (spaces.length === 0) {
    return (
      <main>
        <h1>Memories</h1>
        <p>No spaces yet. Run `klio init` first to provision one.</p>
      </main>
    );
  }

  const activeSpaceId = params.space ?? spaces[0].id;
  const activeSpace =
    spaces.find((s) => s.id === activeSpaceId) ?? spaces[0];
  const kindFilter =
    params.kind && KINDS.includes(params.kind as EntryKind | "all")
      ? (params.kind as EntryKind | "all")
      : "all";
  const limit = Math.min(Math.max(1, Number(params.limit ?? 100)), 500);

  const entries = await api.listEntries(activeSpace.id, {
    kind: kindFilter === "all" ? undefined : kindFilter,
    limit,
  });

  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;

  return (
    <main>
      <h1>Memories</h1>
      <p style={{ marginBottom: "1.5rem" }}>
        Everything Klio has captured for{" "}
        <strong>{activeSpace.name}</strong>. Decrypted server-side at
        request time using your envelope key — never stored unencrypted
        on disk.
      </p>

      <SpaceSwitcher
        spaces={spaces}
        activeId={activeSpace.id}
        kindFilter={kindFilter}
      />

      <SearchForm spaceId={activeSpace.id} />

      <section>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>
          Recent entries
          <span
            className="muted"
            style={{ fontWeight: 400, marginLeft: "0.5rem" }}
          >
            (newest first, up to {limit})
          </span>
        </h2>

        <KindFilter
          spaceId={activeSpace.id}
          activeKind={kindFilter}
          counts={counts}
        />

        {entries.length === 0 ? (
          <p className="muted">No entries match this filter.</p>
        ) : (
          <ul className="list" style={{ listStyle: "none" }}>
            {entries.map((e) => (
              <EntryRow key={e.id} entry={e} space={activeSpace} />
            ))}
          </ul>
        )}
      </section>

      <SpaceMetaFooter space={activeSpace} entries={entries} />
    </main>
  );
}

function SpaceSwitcher({
  spaces,
  activeId,
  kindFilter,
}: {
  spaces: { id: string; name: string }[];
  activeId: string;
  kindFilter: string;
}) {
  if (spaces.length <= 1) return null;
  return (
    <nav
      style={{
        display: "flex",
        gap: "0.5rem",
        flexWrap: "wrap",
        marginBottom: "1.5rem",
      }}
    >
      <span className="muted" style={{ marginRight: "0.5rem" }}>
        Space:
      </span>
      {spaces.map((s) => (
        <Link
          key={s.id}
          href={`/memories?space=${s.id}&kind=${kindFilter}`}
          style={{
            padding: "0.25rem 0.625rem",
            borderRadius: "0.25rem",
            background: s.id === activeId ? "var(--foreground)" : "var(--muted)",
            color: s.id === activeId ? "var(--background)" : "var(--foreground)",
            fontSize: "0.85rem",
            textDecoration: "none",
          }}
        >
          {s.name}
        </Link>
      ))}
    </nav>
  );
}

function KindFilter({
  spaceId,
  activeKind,
  counts,
}: {
  spaceId: string;
  activeKind: string;
  counts: Record<string, number>;
}) {
  return (
    <nav
      style={{
        display: "flex",
        gap: "0.5rem",
        flexWrap: "wrap",
        marginBottom: "1rem",
      }}
    >
      {KINDS.map((k) => {
        const count = k === "all"
          ? Object.values(counts).reduce((a, b) => a + b, 0)
          : counts[k] ?? 0;
        const active = k === activeKind;
        return (
          <Link
            key={k}
            href={`/memories?space=${spaceId}&kind=${k}`}
            style={{
              padding: "0.25rem 0.625rem",
              borderRadius: "0.25rem",
              background: active ? "var(--foreground)" : "var(--muted)",
              color: active ? "var(--background)" : "var(--foreground)",
              fontSize: "0.85rem",
              textDecoration: "none",
            }}
          >
            {k} <span style={{ opacity: 0.7 }}>· {count}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function EntryRow({
  entry,
  space,
}: {
  entry: Entry;
  space: { embedding_model: string };
}) {
  const supersededTooltip = entry.superseded_by
    ? "This entry has been superseded by a newer one — kept for history."
    : null;
  return (
    <li
      className="list-item"
      style={{
        display: "block",
        opacity: entry.superseded_by ? 0.55 : 1,
      }}
    >
      <div style={{ marginBottom: "0.4rem" }}>
        <span
          style={{
            fontSize: "0.75rem",
            padding: "0.125rem 0.5rem",
            borderRadius: "0.25rem",
            background: "var(--muted)",
            marginRight: "0.5rem",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {entry.kind}
        </span>
        <span className="muted" style={{ fontSize: "0.85rem" }}>
          {new Date(entry.created_at).toLocaleString()} · agent{" "}
          {entry.agent_id.slice(0, 8)}…
        </span>
        {supersededTooltip && (
          <span
            title={supersededTooltip}
            style={{
              fontSize: "0.75rem",
              marginLeft: "0.5rem",
              color: "#888",
            }}
          >
            (superseded)
          </span>
        )}
      </div>
      <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {entry.content}
      </div>
      {entry.metadata && Object.keys(entry.metadata).length > 0 && (
        <details style={{ marginTop: "0.4rem", fontSize: "0.85rem" }}>
          <summary className="muted" style={{ cursor: "pointer" }}>
            metadata
          </summary>
          <pre
            style={{
              marginTop: "0.4rem",
              padding: "0.5rem",
              background: "var(--muted)",
              borderRadius: "0.25rem",
              overflow: "auto",
              fontSize: "0.75rem",
            }}
          >
            {JSON.stringify(entry.metadata, null, 2)}
          </pre>
        </details>
      )}
    </li>
  );
}

function SpaceMetaFooter({
  space,
  entries,
}: {
  space: { embedding_model: string; embedding_dim: number; slug: string };
  entries: Entry[];
}) {
  const oldest = entries[entries.length - 1]?.created_at;
  return (
    <footer
      style={{
        marginTop: "2.5rem",
        paddingTop: "1rem",
        borderTop: "1px solid var(--muted)",
        fontSize: "0.85rem",
      }}
      className="muted"
    >
      <strong>{space.slug}</strong> · embedding model:{" "}
      <code>{space.embedding_model}</code> ({space.embedding_dim}d)
      {oldest && (
        <>
          {" · "}oldest entry shown:{" "}
          {new Date(oldest).toLocaleDateString()}
        </>
      )}
    </footer>
  );
}
