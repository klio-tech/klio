# Security policy

Klio's whole pitch is *local-first, encrypted, auditable*. If we ever
fail at any of those, we want to hear about it before someone
malicious does.

## Reporting a vulnerability

**Do NOT open a public GitHub issue for security bugs.** That tells
the world before we have a chance to patch.

Instead, email the author directly:

  📧 **asingh@oppla.ai**

Subject line prefix `[Klio Security]` so it doesn't get lost in
normal correspondence.

Include:

1. A description of the vulnerability and why it matters.
2. Steps to reproduce (or a proof-of-concept exploit if you have one).
3. The affected version (commit SHA preferred; `klio version`
   output otherwise).
4. Your name / handle for credit (optional — anonymous reports are
   accepted).

You should expect:

- An acknowledgement within **48 hours**.
- An initial assessment within **7 days**.
- A fix or detailed explanation of the issue within **90 days**
  (sooner for high-severity issues).
- Public disclosure coordinated with you, once the fix is shipped.

## Hall of fame

Security researchers who responsibly disclose valid vulnerabilities
get credited in [SECURITY-HALL-OF-FAME.md](SECURITY-HALL-OF-FAME.md)
(maintained at first credit). Once Klio is funded enough to support a
bounty program, valid prior disclosures will receive **retroactive
bounties** at the then-current rate.

## Scope

What we consider in-scope for a coordinated-disclosure report:

- **Engine** (`engine/`): authentication bypass, ACL bypass between
  spaces or users, SQL injection, leaks of decrypted data,
  audit-chain tamper-resistance failures, KMS key compromise paths.
- **Bridge daemon** (`bridge/`): unauthenticated MCP shim,
  privilege escalation via socket, credential leaks from the
  keychain backend, hook command injection.
- **Trust-app** (`trust-app/`): XSS, CSRF, session-cookie leakage,
  token replay, data leaks across users.
- **Cryptography**: misuse of AES-GCM (nonce reuse, key leak),
  weak HMAC use for JWTs, missing input validation on KMS unwraps.
- **Audit chain**: ability to mutate a row without breaking the
  chain, or to forge a notarization.
- **Build / supply chain**: malicious dependency you've
  identified that ships with Klio.

What's out of scope (please don't report these):

- Lack of TLS in local-only dev mode (the engine listens on
  `127.0.0.1:8000` by design).
- Missing rate-limiting on a single-user local engine.
- The dev KMS master key being unencrypted on disk
  (`~/.klio/dev-kms.key`) — this is a documented limitation of
  the dev backend; production deployments use real AWS KMS.
- Anything that requires shell access on the user's machine to
  exploit (Klio's threat model assumes the local OS user is
  trusted; if your attacker is already root on the laptop, the
  game's over for any local-first product).
- DDoS / resource exhaustion on a self-hosted instance the user
  controls.

## Threat model

The full threat model is in
[docs/security/threat-model.md](docs/security/threat-model.md).
Key assumptions worth highlighting:

1. **The local OS user is trusted.** Klio doesn't try to defend
   against an attacker with root on your laptop.
2. **The Klio Cloud (when launched) is trusted by Klio Cloud
   subscribers, but not by self-hosters.** OSS Klio never sends
   data to klio.tech without an explicit user opt-in.
3. **The audit chain is tamper-evident, not tamper-proof.** A
   sufficiently determined attacker with disk access can rewrite
   history; the chain just makes that detectable.
4. **Encryption is at-rest on the same machine.** Klio doesn't
   defend against memory dumps of a live engine process.

## Disclosure rules

We follow the [Google Project Zero](https://googleprojectzero.blogspot.com/p/vulnerability-disclosure-faq.html)-style
90-day disclosure window:

- 0 days: vulnerability reported privately
- ≤ 7 days: assessment confirmed and severity assigned
- ≤ 90 days: fix shipped + public advisory
- 90+ days: if the issue can't be fixed in time, we will publish
  a workaround and acknowledge the issue publicly even without a
  fix, so users can mitigate themselves.

For critical vulnerabilities (RCE, ACL bypass, key compromise) we
move faster.

## Known issues

None at the time of writing. This section will list any open issues
once Klio has a wider user base.

## Past advisories

None yet. Format will be `YYYY-MM-DD-<short-slug>.md` in
[docs/security/advisories/](docs/security/) once we have any.

---

Thank you for helping keep Klio safe for everyone.

— Abhishek Singh, Klio author
