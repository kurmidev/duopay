# Changelog

All notable changes are listed here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-07
### Added
- HLD, LLD, API spec, database design, requirements, ADR-001 to ADR-010, roadmap.
- Claude Code workflow: `.claude/CLAUDE.md`, rules, slash commands (`/plan` … `/pr`), sub-agents, permissions, and a security-lint hook after every edit.
- Per-SIM device binding (SMS token to a random VMN; 45 s expiry; 3 attempts per SIM per 24h; same token from two numbers rejected).
- One profile per active SIM number with a state machine (BOUND → ACTIVE ⇄ SUSPENDED → DEREGISTERED).
- Continuous SIM integrity on every signed request; a different SIM in a slot deregisters that profile.
- Account discovery per profile with a shared NPCI list-account quota; unified account list.
- Payments with the NPCI CL simulator (RSA-OAEP PIN block), per-profile request signatures, idempotency, limits, cooling-off, device-level risk rules, paced status checks, no `ReqPay` retries.
- AI routing advisor (Claude, forced tool call) with eligibility rules, a permutation check, number grounding and a rules fallback.
- Binding operator cross-check (ADR-010): reject a token relayed from a SIM in another phone.
- Security lint (`npm run lint:sec`) wired as a Claude Code hook.

### Security
- Fixed findings H1–L4 from the independent security review (see docs/security-review.md): binding cap race, attempt-limit bypass, discovery without SIM, simulators in production, low-entropy VPAs, keyed audit chain.
- Phone simulator with two SIM slots, the DuoPay app UI, and an ops console with a hash-chained audit log.
