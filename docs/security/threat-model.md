# Klio Threat Model

**Status:** Public, v0 (2026-05-02)
**Tier:** 2 — standard SaaS hardening + agent-substrate-specific threat model + VDP

This document is the canonical, public threat model for Klio. It maps STRIDE
threats and substrate-specific threats to mitigations, documents the five
hard guarantees that bound the bug-bounty scope, and lists the assumptions
under which the security analysis holds.

## Five hard guarantees

These are the security properties Klio commits to publicly. Bug-bounty
findings that violate any of them are Critical:

1. **No entry crosses spaces without an explicit grant.** Every read query
   filters by `(user_id, space_id)` BEFORE the HNSW vector search. Coordinator
   AND engine both check the permissions table on every request.
2. **No agent reads a space it doesn't have permission for.** The Permission
   table is the source of truth; engine re-checks on every query.
3. **No data leaves the machine in local-only mode.** Daemon's local-only
   mode disables the cloud client and all telemetry / update checks.
4. **Audit log is tamper-evident.** SHA-256 hash chain over all privileged
   actions; planned hourly notarization to OpenTimestamps.
5. **User holds the off switch.** `klio uninstall --purge` triggers immediate
   hard delete (cloud account deletion, encryption keys destroyed).

## STRIDE — applied

| Threat | Substrate-specific instance | Primary mitigation |
|---|---|---|
| Spoofing | Hostile agent claims to be Claude Code | Per-agent API token, agent_id minted server-side, never trusted from client claim |
| Tampering | MITM rewrites entries | TLS 1.3 mandatory, certificate pinning (planned), HMAC-SHA256 JWT |
| Repudiation | User claims they didn't grant access | Audit log Merkle hash chain, append-only, planned hourly notarization |
| Information disclosure | Cross-tenant retrieval bug | Tenant-isolated CTE before HNSW search, double ACL check (coordinator + engine) |
| DoS | Anonymous account spam | Rate limit per IP/ASN/fingerprint (planned), anonymous quotas, exponential backoff |
| Elevation of privilege | `read` agent tries to `write` | ACL enforced inside engine query; `read` token can't reach `write` endpoint |

## Substrate-unique threats

| Threat | Mitigation |
|---|---|
| Memory poisoning | Per-entry provenance metadata, source-trust scoring (planned), user-marked "untrusted" sources |
| Cross-agent exfiltration | Write requires explicit space_id; trust app daily summary shows what was written |
| Provisioning abuse | Rate limit per IP/ASN, CAPTCHA on burst (planned), anon quotas, 14-day inactive auto-delete (planned) |
| Daemon compromise | Tokens scoped to install_id, rotation on every access-token mint, geolocation anomaly revocation (planned), new-device notifications (planned) |
| Agent ACL escalation | User approval required (auto-prompt — planned for daemon); admin scope requires fresh user re-auth |
| Subpoena / legal | Per-user envelope keys, key destruction on hard delete, planned quarterly transparency report, planned warrant canary on klio.tech |

## Cryptographic posture

```
At rest
  Postgres data           AES-256-GCM, KMS-managed envelope keys
  Local cache (SQLite)    AES-256-GCM, key from OS keychain
  S3 raw events           AES-256-GCM, per-user envelope keys
  Daemon credentials      OS keychain (macOS Keychain / libsecret /
                          Credential Manager) with AES-256-GCM file fallback

In transit
  Daemon ↔ cloud          TLS 1.3 (planned: certificate pinning)
  Trust app ↔ cloud       TLS 1.3, HSTS, secure cookies (planned: preload)
  WebSocket               wss:// only

In use
  Vector embeddings       Per-tenant CTE before HNSW; scoped index
  Extraction pipeline     Plaintext only in worker memory; encrypted
                          before write to Postgres / S3
```

## What is NOT in scope (and why)

- **End-to-end encryption.** Extraction, dedup, recall, and cross-agent
  intelligence all require server-readable content. E2EE would block these.
  Self-hosted deployments where the user owns the keys are the E2EE answer.
- **Funded bounty payouts at v0.** We are early-stage and have committed
  publicly to retroactive bounty payouts post-seed. Until then, valid
  findings get Hall of Fame credit + swag.
- **Multi-region failover.** v0 is single-region (US-East). Cross-region
  fail-over is a Phase L+ task.
- **HIPAA / FedRAMP / SOC2 Type 1 in v0.** SOC2 process kicks off
  post-launch, target completion 6 months. HIPAA explicitly out of scope.

## Assumptions

The analysis assumes:
- Postgres, Redis, and the engine process run on infrastructure the user
  trusts (in cloud, that's Klio's hosting; self-hosted, that's the user's
  own).
- KMS (or Vault / Docker secret in self-host) is configured with a master
  key that no Klio engineer can extract.
- TLS certificates for `*.klio.tech` are not compromised at the CA level.
- The user's local OS keychain is not compromised by other processes.

When any of these assumptions fail, the relevant guarantees may not hold.
