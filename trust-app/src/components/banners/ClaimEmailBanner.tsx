"use client";

// trust-app/src/components/banners/ClaimEmailBanner.tsx
//
// Inline claim-email banner rendered above the (local) dashboard
// content. The server component in (local)/layout.tsx fetches
// /v1/system/banners and, for the `claim_email` kind, hands the
// banner payload to this client component.
//
// The form posts to the engine's login-link endpoint directly from
// the browser (no server-action round-trip) — this matches the
// public LoginForm flow's contract, but keeps the entire submit
// experience in-banner so the dashboard never unmounts. On success
// the banner morphs into a "magic link sent" confirmation; on HTTP
// failure the error renders inline above the form.
//
// Styling matches the surrounding dashboard's inline-style
// convention (the rest of the (local) routes use inline `style={…}`
// with CSS variables from globals.css). We intentionally do not
// introduce new CSS classes for the banner — keeping it visually
// adjacent to the existing card / list aesthetics.

import { useState } from "react";

import type { Banner } from "@/lib/system-banners";

type Props = {
  banner: Banner;
  engineURL: string;
};

type Status = "idle" | "submitting" | "sent" | "error";

const DEFAULT_LOGIN_LINK_PATH = "/v1/auth/login-link";

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.85rem 1.1rem",
  margin: "0 2rem 1.25rem",
  border: "1px solid var(--klio-border-strong)",
  borderRadius: "0.4rem",
  background: "var(--klio-paper)",
  color: "var(--klio-foreground)",
  fontSize: "0.9rem",
};

const successStyle: React.CSSProperties = {
  ...containerStyle,
  justifyContent: "flex-start",
};

const formStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  flexWrap: "wrap",
  alignItems: "center",
};

const inputStyle: React.CSSProperties = {
  minWidth: "16rem",
  flex: "1 1 16rem",
};

const errorStyle: React.CSSProperties = {
  color: "#dc2626",
  fontSize: "0.8rem",
  marginTop: "0.35rem",
};

const bodyStyle: React.CSSProperties = {
  flex: "1 1 18rem",
  minWidth: 0,
  color: "var(--klio-foreground)",
};

const titleStyle: React.CSSProperties = {
  fontWeight: 600,
  display: "block",
  marginBottom: "0.15rem",
};

const subtitleStyle: React.CSSProperties = {
  margin: 0,
  color: "var(--klio-muted)",
  fontSize: "0.85rem",
};

/**
 * Resolve the absolute submit URL for the banner action.
 *
 * The server-rendered banner payload includes a relative endpoint
 * (e.g. `/v1/auth/login-link`); we resolve it against the engine
 * base URL the layout passes down. If the payload is missing the
 * `action.form.endpoint`, fall back to the canonical login-link
 * path so the surface is still functional.
 */
function resolveSubmitURL(banner: Banner, engineURL: string): string {
  const path = banner.action?.form.endpoint ?? DEFAULT_LOGIN_LINK_PATH;
  const base = engineURL.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

export function ClaimEmailBanner({ banner, engineURL }: Props) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  if (status === "sent") {
    return (
      <div style={successStyle} role="status" aria-live="polite">
        <div style={bodyStyle}>
          <span style={titleStyle}>Magic link sent.</span>
          <p style={subtitleStyle}>
            Check your email and click the link to claim your account.
          </p>
        </div>
      </div>
    );
  }

  const submitLabel = banner.action?.label ?? "Claim";

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!email) return;
    setStatus("submitting");
    setErrorMsg("");
    try {
      const res = await fetch(resolveSubmitURL(banner, engineURL), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setStatus("sent");
        return;
      }
      setStatus("error");
      setErrorMsg(`Couldn't send link (HTTP ${res.status}). Try again.`);
    } catch (err) {
      setStatus("error");
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Couldn't reach the engine: ${msg}`);
    }
  };

  return (
    <div style={containerStyle} role="region" aria-label={banner.title}>
      <div style={bodyStyle}>
        <span style={titleStyle}>{banner.title}</span>
        <p style={subtitleStyle}>{banner.body}</p>
        {status === "error" && errorMsg && (
          <p style={errorStyle} role="alert">
            {errorMsg}
          </p>
        )}
      </div>
      <form onSubmit={onSubmit} style={formStyle}>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(ev) => setEmail(ev.target.value)}
          disabled={status === "submitting"}
          aria-label="Email address"
          style={inputStyle}
        />
        <button type="submit" disabled={status === "submitting" || !email}>
          {status === "submitting" ? "Sending…" : submitLabel}
        </button>
      </form>
    </div>
  );
}
