import Link from "next/link";

import { api, type Entry, type EntryKind, type Project } from "@/lib/api";

import { ProjectFilter } from "./project-filter";
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
  project?: string;
  limit?: string;
};

export default async function MemoriesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  // listSpaces stays a hard failure — the page genuinely can't render
  // without a space. listProjects is best-effort: the project filter is
  // an enhancement, not a gate, so it must not take the dashboard down.
  const [spaces, projects] = await Promise.all([
    api.listSpaces(),
    api.listProjects().catch((e) => {
      // An older engine (image/version skew) returns 404 on
      // GET /v1/projects — degrade to "no projects" so the dashboard
      // still renders entries instead of 500ing the whole page.
      // Logged server-side rather than silently swallowed (per the
      // project's error-handling rule).
      console.error("listProjects failed; hiding project filter:", e);
      return [] as Project[];
    }),
  ]);
  if (spaces.length === 0) {
    return (
      <main>
        <h1>Memories</h1>
        <p>No spaces yet. Run `klio init` first to provision one.</p>
      </main>
    );
  }

  const projectsById = new Map(projects.map((p) => [p.id, p]));

  const activeSpaceId = params.space ?? spaces[0].id;
  const activeSpace =
    spaces.find((s) => s.id === activeSpaceId) ?? spaces[0];
  const kindFilter =
    params.kind && KINDS.includes(params.kind as EntryKind | "all")
      ? (params.kind as EntryKind | "all")
      : "all";
  // Only honour a project filter that actually exists; an unknown UUID
  // falls back to "All projects" rather than silently returning nothing.
  const activeProjectId =
    params.project && projectsById.has(params.project)
      ? params.project
      : undefined;
  const limit = Math.min(Math.max(1, Number(params.limit ?? 100)), 500);

  const entries = await api.listEntries(activeSpace.id, {
    kind: kindFilter === "all" ? undefined : kindFilter,
    projectId: activeProjectId,
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
        projectId={activeProjectId}
      />

      <ProjectFilter
        projects={projects}
        activeProjectId={activeProjectId ?? null}
        spaceId={activeSpace.id}
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
          projectId={activeProjectId}
        />

        {entries.length === 0 ? (
          <p className="muted">No entries match this filter.</p>
        ) : (
          <ul className="list" style={{ listStyle: "none" }}>
            {entries.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                space={activeSpace}
                projectsById={projectsById}
              />
            ))}
          </ul>
        )}
      </section>

      <SpaceMetaFooter space={activeSpace} entries={entries} />
    </main>
  );
}

// Build a /memories href that always preserves the space, kind and
// project filters together, so changing one never drops the others.
// Omitting `project` (the "All projects" case) leaves the param off the
// URL entirely rather than emitting an empty value.
function memoriesHref({
  spaceId,
  kind,
  projectId,
}: {
  spaceId: string;
  kind: string;
  projectId?: string;
}) {
  const qs = new URLSearchParams({ space: spaceId, kind });
  if (projectId) qs.set("project", projectId);
  return `/memories?${qs}`;
}

function SpaceSwitcher({
  spaces,
  activeId,
  kindFilter,
  projectId,
}: {
  spaces: { id: string; name: string }[];
  activeId: string;
  kindFilter: string;
  projectId?: string;
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
          href={memoriesHref({ spaceId: s.id, kind: kindFilter, projectId })}
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
  projectId,
}: {
  spaceId: string;
  activeKind: string;
  counts: Record<string, number>;
  projectId?: string;
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
            href={memoriesHref({ spaceId, kind: k, projectId })}
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
  projectsById,
}: {
  entry: Entry;
  space: { embedding_model: string };
  projectsById: Map<string, Project>;
}) {
  const supersededTooltip = entry.superseded_by
    ? "This entry has been superseded by a newer one — kept for history."
    : null;
  // Show the human-readable project name when we have it. An entry that
  // references a project not in the list (e.g. created since the page was
  // rendered, or the projects fetch degraded to empty) falls through to
  // the "uncategorized" label rather than surfacing a noisy truncated id.
  const projectLabel = entry.project_id
    ? projectsById.get(entry.project_id)?.display_name ?? null
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
        {projectLabel ? (
          <span
            title={`Project: ${projectLabel}`}
            style={{
              fontSize: "0.72rem",
              padding: "0.1rem 0.45rem",
              marginLeft: "0.5rem",
              borderRadius: "0.25rem",
              border: "1px solid var(--border)",
              color: "var(--muted-foreground)",
              whiteSpace: "nowrap",
            }}
          >
            {projectLabel}
          </span>
        ) : (
          <span
            className="muted"
            style={{ fontSize: "0.72rem", marginLeft: "0.5rem", opacity: 0.7 }}
          >
            · uncategorized
          </span>
        )}
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
