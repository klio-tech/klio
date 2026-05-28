"use client";

import { useRouter } from "next/navigation";

import type { EntryKind, Project } from "@/lib/api";

/**
 * Project filter for the /memories page.
 *
 * A dropdown (not a tab row) because a user can accumulate many projects
 * — one per repo they've worked in — which would overflow a horizontal
 * tab bar. The space switcher and kind filter stay as tabs because those
 * sets are small and fixed.
 *
 * This is the only client component on the page: a native <select> needs
 * an onChange handler to navigate, which a server component can't carry.
 * On change it pushes a new /memories URL that preserves the current
 * space and kind so all three filters compose. Selecting "All projects"
 * drops the `project` param entirely.
 *
 * Renders nothing when there are no projects yet (pre-0.7.0 tenants),
 * so the page stays clean until per-project scoping is in use.
 */
export function ProjectFilter({
  projects,
  activeProjectId,
  spaceId,
  kindFilter,
}: {
  projects: Project[];
  activeProjectId: string | null;
  spaceId: string;
  kindFilter: EntryKind | "all";
}) {
  const router = useRouter();

  if (projects.length === 0) return null;

  function onChange(nextProjectId: string) {
    const qs = new URLSearchParams({ space: spaceId, kind: kindFilter });
    if (nextProjectId) qs.set("project", nextProjectId);
    router.push(`/memories?${qs}`);
  }

  return (
    <nav
      style={{
        display: "flex",
        gap: "0.5rem",
        alignItems: "center",
        flexWrap: "wrap",
        marginBottom: "1.5rem",
      }}
    >
      <label
        htmlFor="project-filter"
        className="muted"
        style={{ marginRight: "0.25rem" }}
      >
        Project:
      </label>
      <select
        id="project-filter"
        value={activeProjectId ?? ""}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "0.25rem 0.5rem",
          borderRadius: "0.25rem",
          border: "1px solid var(--border)",
          background: "var(--background)",
          color: "var(--foreground)",
          fontSize: "0.85rem",
          fontFamily: "inherit",
          maxWidth: "100%",
        }}
      >
        <option value="">All projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.display_name} ({p.entry_count})
          </option>
        ))}
      </select>
    </nav>
  );
}
