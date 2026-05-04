"use client";

/**
 * Hero install-snippet panel.
 *
 * One-row, monospace, copy-on-click. Mirrors the pattern Vercel /
 * Supabase / tailwindcss.com use on their hero sections — visitors
 * see the install command, click once, paste in their terminal.
 *
 * Renders as a client component because it needs the Web Clipboard
 * API and a tiny piece of "✓ copied" feedback state. Everything
 * else on the landing page stays server-rendered.
 */

import { useEffect, useState } from "react";

const INSTALL_COMMAND = "npx @klio-tech/klio init";

export function InstallSnippet() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    // Auto-revert the "copied" pill back to "copy" after 1.6s so a
    // user who copied once and walks back to the terminal doesn't
    // see a stale confirmation on their next visit. Cheap timer
    // cleared on unmount or on re-click.
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  async function handleCopy() {
    try {
      // Modern browsers, secure-context only. Falls back to the
      // legacy execCommand path below for http://localhost
      // dev / older builds.
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      return;
    } catch {
      // Fall through to legacy path.
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = INSTALL_COMMAND;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      // execCommand is deprecated but still works everywhere we ship.
      // Reachable only when the modern clipboard API rejects (rare).
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
    } catch {
      // Last resort: surface nothing — the command is visible
      // on-screen, the user can select it manually. We don't want
      // to spam an alert() on a copy failure.
    }
  }

  return (
    <div
      role="region"
      aria-label="Install command"
      style={{
        marginTop: "1.8rem",
        display: "flex",
        alignItems: "stretch",
        background: "var(--klio-paper)",
        border: "1px solid var(--klio-border)",
        borderRadius: "0.55rem",
        overflow: "hidden",
        maxWidth: "32rem",
        fontFamily: "var(--font-mono-stack)",
      }}
    >
      <div
        style={{
          flex: "1 1 auto",
          padding: "0.85rem 1rem",
          display: "flex",
          alignItems: "center",
          gap: "0.55rem",
          minWidth: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            color: "var(--klio-faint)",
            fontWeight: 500,
            userSelect: "none",
          }}
        >
          $
        </span>
        <code
          style={{
            color: "var(--klio-foreground)",
            fontSize: "0.94rem",
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
        >
          {INSTALL_COMMAND}
        </code>
      </div>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Command copied to clipboard" : "Copy command to clipboard"}
        style={{
          flexShrink: 0,
          padding: "0 1.05rem",
          borderLeft: "1px solid var(--klio-border)",
          background: "transparent",
          color: copied ? "var(--klio-foreground)" : "var(--klio-muted)",
          fontFamily: "var(--font-mono-stack)",
          fontSize: "0.78rem",
          fontWeight: 500,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          cursor: "pointer",
          transition: "color 120ms ease",
        }}
      >
        {copied ? "✓ copied" : "copy"}
      </button>
    </div>
  );
}
