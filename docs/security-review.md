# Security review record: v0.1

| | |
|---|---|
| Date | 2026-10-07 |
| Reviewer | Independent sub-agent following `.claude/agents/security-reviewer.md`. It had not seen the code being written and had read-only access. |
| Scope | Full repository: `src/`, `public/`, tests, against `.claude/rules/security.md`, HLD §3 (C1–C10) and HLD §11 |
| Method | Code reading plus proof-of-concept scripts against a running instance; `npm test` and `npm run lint:sec` |

## Findings and resolution

| ID | Severity | Finding | Fix | Regression test |
|---|---|---|---|---|
| H1 | High | Several pending bindings (one per slot) could complete and exceed the profile cap: 3 live profiles where the cap is 2 | One binding in flight per device (`BINDING_IN_PROGRESS`); slot and cap re-checked when the SMS arrives | `review-fixes: H1` |
| H2 | High | Limit of 3 binding attempts per 24h was counted per client-supplied SIM fingerprint, so rotating it (or re-registering the app) reset the limit | Count per slot and per device, and per number when the SMS arrives (survives re-installs) | `review-fixes: H2` ×2 |
| M1 | Medium | `ReqListAccount` could run for a BOUND profile with its SIM absent or in airplane mode, which activated the profile | Discovery checks this request's signed SIM state itself | `review-fixes: M1` |
| M2 | Medium | The ADR-010 operator check trusts the carrier the device reports; a tampered app can claim any carrier | ADR-010 and HLD reworded to "client-trust control"; production requires a telco number-verification API (open item O6) | (Documented; real fix is an integration) |
| M3 | Medium | `NODE_ENV=production` + `ENABLE_SIMULATORS=true` exposed fake-SMS and ops routes | Simulators forced off in production | `review-fixes: M3` |
| M4 | Medium | VPA had only 16 bits of entropy (collisions after ~340 numbers per slot), and a deregistered VPA could be reissued to another number | 64-bit random VPA, unique across all rows, never reissued | `review-fixes: M4` |
| L1 | Low | A constraint error inside the SMS handler returned 500 and left the token re-usable | Fail closed (`PROFILE_CONFLICT`), consuming the token | covered by H1 path |
| L2 | Low | `?limit=-1` returned every row; `?limit=1.5` gave a 500 | Clamped to an integer 1–100 | `review-fixes: L2` |
| L3 | Low (policy) | Discovery allowed on ACTIVE profiles (adding accounts later) may stretch OC-95 "only during onboarding" | Logged as HLD open item O7 for compliance | — |
| L4 | Low | Unkeyed audit hash chain could be rewritten by someone with DB access | Chain is now HMAC-keyed with `DATA_KEY` | `review-fixes: L4` |

## Verified as safe by the reviewer
Request signing (method, path, timestamp, nonce, body and SIM header all signed); profile isolation (SIM 1's key can't pay from SIM 2's account); no await between the SIM check and payment; idempotency and no `ReqPay` retry; NPCI status-check pacing; limits checked and inserted in one transaction; isolation between installations on every route; no PIN, credBlock, token, ICCID, number or balance in the DB, logs or responses; AI advisor gets no PII and its output can't change eligibility; parameterised SQL everywhere; no HTML injection in the UI; strict CSP and security headers.

**After the fixes:** 54/54 tests pass; `npm run lint:sec` is clean.
