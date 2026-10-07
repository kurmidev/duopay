---
description: Security and compliance review (UPI/NPCI/RBI/DPDP) of the diff or the whole codebase
argument-hint: [diff | full]
---
Use the `security-reviewer` sub-agent. Scope: **${ARGUMENTS:-diff}** (`diff` = changes against main, `full` = whole repo).

Review against `.claude/rules/security.md`, HLD §3 (constraints C1–C10) and HLD §11 (threat model). At minimum, try to break:
- **Binding:** token reuse, expiry, attempts, same token from two numbers, binding with SIM absent or in airplane mode.
- **Profile isolation:** paying from SIM 2's account with SIM 1's key or with SIM 2 absent; tampering with `X-Sim-State`.
- **Replay and idempotency:** reused nonce, same Idempotency-Key with a different body, double debit on PENDING.
- **Data:** PIN, credBlock, token, ICCID, number or balance in logs, DB, responses or audit.
- **NPCI pacing:** list-account quota shared across profiles; status-check spacing.
- **AI:** any PII in advisor features; a model output that bypasses eligibility.
- **Web:** XSS in the UI, missing headers, simulator routes reachable with `NODE_ENV=production`.

For each finding: severity (critical/high/medium/low), exploit scenario, evidence (file:line), fix, and the test that proves the fix. Also run `npm run lint:sec` and `npm test`.
