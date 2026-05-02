# VDP Triage Runbook (internal)

When a security report arrives at `security@klio.tech`:

## 0–24h
- Acknowledge receipt within 24 hours.
- Open a private issue in `klio-tech/security-internal` (private repo).
- Tag with severity (preliminary): Critical / High / Medium / Low.
- Assign to a rotating triage owner.

## 24h–7d
- Confirm reproducibility on a staging environment.
- Confirm severity. Critical/High = drop everything. Medium/Low = next sprint.
- Notify the reporter weekly with status updates.

## Severity matrix

| Severity | Examples | SLA to fix | Public disclosure |
|---|---|---|---|
| Critical | Cross-tenant data leak, account takeover, encryption bypass | 7 days | Coordinated, max 90 days |
| High | Privilege escalation within tenant, ACL bypass, audit-log tamper | 14 days | Coordinated, max 90 days |
| Medium | Auth flaws, token leakage, rate-limit bypass | 30 days | Coordinated, max 90 days |
| Low | Information disclosure, DoS without amplification | next sprint | At reporter's preference |

## Fix process

1. Reproduce on staging.
2. Write a regression test that fails before the fix.
3. Implement the fix, ensure the test passes.
4. Code review by 2 engineers (security + domain owner).
5. Deploy to staging, verify.
6. Deploy to production. Tag the deploy as a security release.
7. Update the audit log + transparency log (planned).

## Communication

### To reporter
- 24h ack
- Weekly status (or sooner on milestone)
- Final notification with CVE (if any), Hall of Fame credit, and swag offer.

### Public
- Critical/High get a published advisory once fixed and propagated.
- Hall of Fame entry within 7 days of fix release.

## When in doubt

Escalate to founders. Better to slow down than to fumble disclosure.
