# Licensing — split, transparent, deliberate

Klio is a **split-licensed open-source project** with a **proprietary
cloud sibling**. Three things that look like licensing complexity but
are actually a clean three-tier model.

## Tier 1 — Apache 2.0 (within this repo, permissively licensed)

Two specific subdirectories are licensed under
[Apache License 2.0](LICENSE-APACHE-2.0):

| Subdirectory | Why permissive | What it is |
|---|---|---|
| [`bridge/cmd/klio-mcp/`](bridge/cmd/klio-mcp/) | This is the MCP server binary. Closed-source agents (Cursor, Codex, Claude Code itself) need to be able to spawn it as a subprocess and ship it inside their installers without copyleft entanglement. Apache 2.0 makes that legally clean. | A ~400-line stdio JSON-RPC shim. No business logic; routes MCP tool calls to the daemon. |
| [`claude-plugin/`](claude-plugin/) | Distributed inside Claude Code's own plugin registry, where the surrounding distribution is permissive. | Plugin manifest + skills + slash-command templates. |

Each of these subdirectories carries its own `LICENSE` file containing
the verbatim Apache 2.0 text. SPDX identifier: `Apache-2.0`.

The `klio-mcp` binary is also **fully self-contained** (verified by
`go list -deps`): it imports nothing from `bridge/internal/*`. So the
Apache 2.0 boundary holds at the link layer too — the compiled
`klio-mcp` binary contains zero AGPL code.

## Tier 2 — AGPL v3 (everything else in this repo)

Everything in this repo *outside* the two subdirectories above is
licensed under
[GNU Affero General Public License v3](LICENSE):

| Path | What it is |
|---|---|
| `engine/` | The actual memory engine. Postgres + pgvector schema, encryption, audit chain, ACL, recall, embeddings, reembed. ~6K LOC. |
| `trust-app/` | The Next.js dashboard you run locally to browse memories. |
| `bridge/cmd/klio/` + all `bridge/internal/*` | The daemon, CLI, hooks, keychain, agent adapters, cache, cloud client, realtime subscriber. |
| `docs/` + `infra/` + root files (README, etc.) | Documentation and infra glue. |

SPDX identifier: `AGPL-3.0-or-later`.

### What AGPL v3 means for you

- **Use it personally / inside your team / inside your company —
  no obligations.** AGPL only triggers when you *distribute* or
  *operate as a service for others*.
- **Modify it.** Run a fork on your laptop, your VPN, your
  airgapped cluster. Still no obligations.
- **Distribute a modified version OR offer your modified version
  as a service to other people**: you must release your modified
  source under AGPL v3 too. This is the SaaS protection clause —
  it's the entire reason AGPL was written.
- **Embed AGPL Klio (engine, daemon, trust-app) inside a
  closed-source product**: not allowed without a commercial
  license. Email asingh@oppla.ai to discuss one if you need
  embedding rights.

### Why AGPL v3 instead of GPL v3 or Apache?

- **GPL v3** has a SaaS loophole — you can host modified GPL
  software as a service without releasing the source. AGPL v3
  closes it. We picked the version that actually protects against
  rent-seeking cloud hosters.
- **Apache 2.0 alone** would let any megacorp host Klio's engine
  as a competing managed service. We wanted to keep that path
  closed without blocking the embeddability of the MCP shim
  itself — hence the split.
- **AGPL v3 alone** would block embedding the MCP shim in
  Cursor / Codex, killing the cross-agent collaboration story.
  Hence the split.

## Tier 3 — Proprietary (Klio Cloud, separate private repo)

The future hosted **Klio Cloud** at `cloud.klio.tech` lives in a
private repository (not yet created) and is licensed under a
proprietary commercial license. It includes:

- Per-project space auto-routing (cwd / git-remote → space)
- Cross-agent intelligence (Claude + Cursor sharing context with
  conflict resolution)
- Premium connectors (Salesforce, Notion, Linear, Slack, Gmail,
  Google Drive)
- Team RBAC beyond the single-user ACL of the OSS
- Hosted SSO (Google, Microsoft, Okta)
- Managed multi-region Postgres + AWS KMS with SOC2 attestation
- Hosted observability + billing + metering

Klio Cloud builds *on top of* the AGPL engine but is licensed
separately because the operator (Abhishek Singh / Klio) holds the
copyright to both, which under AGPL §7 allows additional/different
licensing terms by the rights-holder. Klio Cloud is NOT a
derivative work distributed under AGPL; it's a separate product.

If you're a **third-party operator** (anyone other than Klio) and
you want to host the AGPL Klio engine as a service for others,
your hosted version must release its modified source under AGPL.
That's the protection.

## TL;DR — what you can do

| You want to… | License you operate under | Allowed? |
|---|---|---|
| Run Klio on your laptop / your team's server | (none required — personal use) | ✅ |
| Fork the engine and run it for yourself | AGPL v3 | ✅ |
| Embed the MCP shim in a closed-source agent | Apache 2.0 (shim is permissive) | ✅ |
| Host Klio's engine as a SaaS for paying customers | AGPL v3 | ✅ but you must publish your modified source |
| Embed the AGPL engine in a closed-source product | none compatible | ❌ — get a commercial license |
| Use Klio Cloud as a paid customer | proprietary EULA | ✅ — sign up |
| Compete with Klio Cloud by hosting our engine | AGPL v3 | ✅ but your fork's source is public, and we'll watch |

## Trademarks

"Klio", the Klio logo, and "klio.tech" are trademarks of Abhishek
Singh, the project author. License grants do NOT extend to
trademarks (Apache 2.0 §6 and AGPL §7 both make this explicit).

You can:
- Reference Klio by name when describing your fork or downstream
  product ("Built on Klio", "Compatible with Klio").
- Use the Klio name in academic writing, blog posts, conference
  talks.

You can't:
- Call your fork "Klio" or any confusingly similar name.
- Use the klio.tech domain or `klio-tech` GitHub org for your
  own software.
- Use Klio's logo as your product's logo.

## Contributor License Agreement

We do not require a CLA. By submitting a PR, you certify that
your contribution is licensable under the same license that
applies to the file(s) you're modifying — Apache 2.0 if you're
touching the shim or plugin, AGPL v3 if you're touching anything
else. The
[Developer Certificate of Origin](https://developercertificate.org)
is the implicit standard.

If your PR adds a new file, it inherits the license of the
directory it's in.

## Practical: what license header should I add to a new file?

For any file under the two Apache directories:

```
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Abhishek Singh
```

For any other file:

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Abhishek Singh
```

(Adjust the comment syntax for the language: `#` for Python /
shell / yaml, `--` for SQL, `<!-- -->` for Markdown, etc.)

License headers are not strictly required (the directory-level
LICENSE files are sufficient under both Apache and AGPL), but
adding them helps automated tooling like
[reuse-tool](https://reuse.software) and makes the boundary
explicit when files get copied around.

## Questions / commercial license inquiries

asingh@oppla.ai · [klio.tech](https://klio.tech)
