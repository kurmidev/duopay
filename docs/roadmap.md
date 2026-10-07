# DuoPay: Roadmap

## v0.1: Prototype (this repo)
- [x] HLD, LLD, API spec, database design, ADRs
- [x] Claude Code workflow: rules, slash commands, sub-agents, security-lint hook
- [x] Per-SIM device binding, profile state machine, continuous SIM integrity
- [x] Account discovery, unified account list, payments with the NPCI CL simulator
- [x] Limits, cooling-off, device-level risk rules, NPCI quotas and status-check pacing
- [x] AI routing advisor with guardrails and rules fallback
- [x] Phone simulator with two SIM slots, ops console, hash-chained audit

## v0.2: Hardening (2–3 weeks)
- Android client (Kotlin): `SubscriptionManager` per-slot state, `SmsManager.getSmsManagerForSubscriptionId` for binding SMS from the right slot, Android Keystore keys, Play Integrity
- PostgreSQL + Redis; migrations; partitioning
- Telco SIM-swap API check at binding and before high-value payments
- Advisor evaluation set: compare ranking acceptance (`suggested_rank = 1` rate) between rules and Claude

## v0.3: Pilot readiness (with a sponsor PSP)
- NPCI and PSP approval for multiple profiles per device (HLD O1); confirm the quota interpretation (O2) and ADR-004 (O3)
- Real PSP adapter, mTLS, HSM-backed keys
- VAPT, DPDP data-protection impact assessment, grievance redressal flow
- Set UPI PIN / reset PIN (`ReqRegMob`), QR scan, collect requests

## Later
- eSIM devices with more than 2 profiles (config + policy)
- UPI Circle hand-off for family accounts
- iOS design (no SIM-slot APIs: explore carrier entitlement / user-confirmed SMS)
