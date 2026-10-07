# Architecture Decision Records

Format: context → decision → consequences. Status is *Accepted* unless noted.

---

## ADR-001: Node.js 22 with no third-party packages
**Context.** The prototype must be easy to run and review. A payments codebase should keep its supply chain small, and the build environment had no npm registry access.
**Decision.** Use only Node 22 built-ins: `node:http`, `node:crypto`, `node:sqlite`, `node:test`; WebCrypto in the browser.
**Consequences.** + No supply-chain risk; runs with `npm start` and nothing to install. − Some hand-written utilities (router, validation). − `node:sqlite` is experimental in Node 22; production moves to PostgreSQL (HLD §13).

## ADR-002: One profile per SIM number, as an independent UPI registration
**Context.** UPI binds a registration to one mobile number on one device. We want both SIMs usable in one app.
**Decision.** Each active SIM number gets its own profile with its own SMS binding, VPA, device key and accounts. The PSP and NPCI see ordinary registrations; grouping lives only in DuoPay.
**Consequences.** + No change to how NPCI or banks treat a registration. + A problem with one SIM affects only its profile. − Two VPAs per user. − Needs NPCI/PSP approval for multiple bound profiles per device (HLD O1).
**Alternatives rejected.** One profile holding several numbers: it breaks the binding model (one token, one number) and C1.

## ADR-003: Simulate external parties behind production-shaped adapters
**Context.** Real NPCI/PSP access needs certification and a sponsor bank.
**Decision.** Telecom, PSP, NPCI, issuer banks and the NPCI CL are simulators. Modules depend only on `adapters/psp.js`.
**Consequences.** + The full flow is demonstrable, including SIM removal, timeouts and wrong PINs. + A real adapter replaces one file. − Simulator fidelity is limited to the documented behaviours.

## ADR-004: SIMs on one device do not need the same owner
**Context.** The product owner decided the second SIM need not belong to the same person; it only has to be **active**. The original design proposed a name-match check because one phone running UPI for several people's numbers is a known mule-account pattern.
**Decision.** No same-owner check. Each profile is proven only by its own SMS binding from an active SIM, as in any single-SIM UPI app. Account-holder names are not stored.
**Consequences / compensating controls.** Profile cap per device = active SIM slots (default 2). Velocity and amount rules run across **all profiles on a device** (risk R1, R2). A different SIM in a slot deregisters the old profile. A full audit trail is kept for the PSP fraud team. **Residual risk accepted by the product owner. Flagged for PSP/compliance review (HLD O3).**

## ADR-005: AI only ranks eligible accounts, without balances or PII
**Context.** Choosing among 4–6 accounts is a real usability problem. NPCI OC-95 forbids storing balances, and an AI must not become a path around limits or risk.
**Decision.** Rules compute eligibility. Claude receives anonymised numeric features and returns a forced-tool ranking plus a reason. The output is validated as a permutation of the eligible accounts with no invented numbers; otherwise a deterministic score is used.
**Consequences.** + The AI can't cause a non-compliant payment. + It works without an API key. − The ranking quality is limited by the features we may lawfully use.

## ADR-006: Continuous SIM presence, applied per profile
**Context.** NPCI requires an active SIM; the DoT directive requiring continuous SIM binding covers messaging apps, not UPI.
**Decision.** Adopt continuous presence anyway. The SIM state is signed into every request; an absent SIM suspends its profile, and a different SIM deregisters it.
**Consequences.** + SIM-swap and stolen-phone windows shrink. − Relies on device-reported state; production adds Play Integrity and telco SIM-swap APIs.

## ADR-007: Per-profile signing keys for payments
**Context.** With two profiles in one app, a bug or a compromised UI could debit SIM 2's account under SIM 1's session.
**Decision.** Each profile gets an ECDSA P-256 key at binding. Payments need a signature from the key of the profile that owns the debited account, on top of the installation signature.
**Consequences.** + Profile isolation is enforced cryptographically. − Two signatures per payment (negligible cost).

## ADR-008: Never retry `ReqPay`; reconcile with paced status checks
**Context.** A timeout doesn't mean failure; retrying could debit twice. NPCI limits status checks.
**Decision.** Idempotency keys on `POST /v1/payments`; PENDING is resolved only through `ReqChkTxn`, ≤3 times within 2h, ≥90 s apart, then `DEEMED_PENDING`.
**Consequences.** + No double debits from DuoPay. − Some payments remain pending until the bank settles them.

## ADR-010: The binding SMS must come from the SIM in this slot (operator cross-check)
**Context.** Found while writing the binding tests. The SMS proves possession of *a* SIM with that number, not that the SIM sits in the slot being bound. A token relayed from a second phone would create a profile tied to slot 1's SIM fingerprint but another SIM's number. Continuous SIM checks would then pass while the number's SIM is elsewhere.
**Decision.** The device reports each slot's MCC-MNC (signed in `X-Sim-State`). Binding stores it, and the SMS is accepted only if the originating number's operator (MNP lookup) matches.
**Consequences.** + An honest app on a normal phone rejects cross-operator relays (tested). − **This is a client-trust control.** A tampered app can claim any carrier for a slot (found by the security review, M2), and same-operator relays aren't caught anyway. **It is not sufficient on its own:** production must verify the number server-side with a telco number-verification API (GSMA Open Gateway style) at binding. Tracked as HLD open item O6.

## ADR-009: NPCI per-app quotas are counted per installation, not per profile
**Context.** NPCI limits some APIs "per app" (e.g. list account 25/day). It's unclear whether two profiles count as one app.
**Decision.** Count per installation (the stricter reading) until the PSP confirms (HLD O2).
**Consequences.** + Compliant under either reading. − Heavy onboarding of two SIMs uses one shared budget.
