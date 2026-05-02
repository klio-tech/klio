# Licensing — open core, transparently

Klio is **open core**: the engine, daemon, MCP shim, CLI, trust-app
dashboard, and reference adapters are all licensed under the
[Apache License 2.0](LICENSE) and live in this public repository.

A separate **Klio Cloud** product — hosted, multi-tenant, with
team-scoped spaces, premium connectors, cross-agent intelligence, and
managed multi-region storage — is proprietary and lives in a private
repository. Klio Cloud builds on top of the same open engine; it does
not modify it under a different license.

This document explains the boundary so contributors, redistributors,
and forkers know exactly what they can do.

## What's Apache 2.0 (this repo)

Everything you can see in [github.com/klio-tech/klio](https://github.com/klio-tech/klio):

| Component | Path | Apache 2.0? |
|-----------|------|-------------|
| Engine (FastAPI + Postgres + pgvector) | `engine/` | ✅ |
| Bridge daemon (Go) | `bridge/cmd/klio` | ✅ |
| MCP shim (Go) | `bridge/cmd/klio-mcp` | ✅ |
| Agent adapters (Claude Code, Cursor, Codex) | `bridge/internal/agentadapters` | ✅ |
| Trust-app dashboard (Next.js) | `trust-app/` | ✅ |
| Claude Code plugin (skills + slash commands) | `claude-plugin/` | ✅ |
| Local file KMS, audit chain, embeddings registry | various | ✅ |
| Documentation, design plans, threat model | `docs/` | ✅ |
| Migrations | `engine/alembic/` | ✅ |

You can:

- Self-host Klio for personal use, your team, your company.
- Fork Klio and ship your own derivative product.
- Bundle Klio inside a closed-source product (the engine binary, for
  example, can be embedded in a commercial app).
- Charge money for Klio-derived products and services.

You must:

- Preserve the `LICENSE` file and copyright notice.
- Note any modifications you've made to Apache 2.0–licensed files.
- Not use the "Klio" trademark or "klio.tech" domain to name a fork
  in a way that implies endorsement (Section 6 of the Apache license).

You don't have to:

- Open-source your own modifications (Apache 2.0 is permissive, not
  copyleft like AGPL or GPL).
- Notify the project of your fork or use.

## What's proprietary (Klio Cloud, separate repo)

The future Klio Cloud — the hosted SaaS at `cloud.klio.tech` —
includes:

- **Per-project space auto-routing** (cwd / git-remote → space)
- **Cross-agent intelligence** (Claude + Cursor sharing context with
  conflict resolution)
- **Premium connectors**: Salesforce, Notion, Linear, Slack, Gmail,
  Google Drive ingest with fan-out
- **Team RBAC** beyond the single-user ACL the OSS shipping with
- **Hosted SSO** (Google, Microsoft, Okta)
- **Managed multi-region Postgres + KMS** with SOC2 attestation
- **Hosted observability** (latency dashboards, anomaly detection)
- **Billing + metering** (per-user, per-space, per-MB-stored)

Klio Cloud lives in a private repository and is licensed under a
proprietary commercial license. It does NOT modify or
re-license the open core; it's an entirely separate product that
imports the open engine as a dependency.

## What's the boundary rule?

Anything that fundamentally needs cloud infrastructure goes in Klio
Cloud:

- multi-tenant orchestration
- billing / usage metering
- centrally-managed connectors (each maintained by the Klio team)
- managed-in-the-cloud-only auth integrations (SSO providers)
- abuse / fraud / spam detection at scale

Anything a self-hoster can run on their own laptop or VPS stays in
the open core.

## I want to use Klio for my company / fork it / package it

You don't need permission. The Apache 2.0 license already grants you
that right. If you want to:

- **Use Klio internally at your company**: just self-host. No
  attribution needed beyond preserving the LICENSE file.
- **Resell Klio as part of your product**: also fine. Trademark rule
  applies — don't call it "Klio" if it's not actually Klio.
- **Contribute back**: PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
- **Talk to us about a paid Klio Cloud plan**: email
  asingh@oppla.ai.

## Trademarks

"Klio", the Klio logo, and "klio.tech" are trademarks of Abhishek
Singh, the project author. The Apache 2.0 license does NOT grant
trademark rights — see Section 6.

You can:
- Reference Klio by name when describing your fork or downstream
  product ("Built on Klio", "Compatible with Klio").
- Use the Klio name in academic writing, blog posts, conference
  talks.

You can't:
- Call your fork "Klio" without the author's written permission.
- Use the klio.tech domain or "klio" namespaces (npm `@klio`, PyPI
  `klio`, the GitHub `klio-tech` org) for your own software.

## Contributor License Agreement

We do not currently require a CLA. By submitting a PR, you certify
that your contribution is licensable under Apache 2.0 (the
[Developer Certificate of Origin](https://developercertificate.org)
is the implicit standard).

If we adopt a formal CLA in the future (e.g., for the Klio Cloud
codebase to use), we'll switch to a Sign-Off-style affirmation
(`git commit -s`) and grandfather all existing contributors.
