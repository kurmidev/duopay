# DuoPay: instructions for Claude

DuoPay is a multi-SIM UPI app prototype: **one UPI profile per active SIM number**, each with its own device binding, and payment from any linked account. It is a payments system, so correctness, security and compliance outrank speed and cleverness.

## Read before working
- Design: @docs/hld.md (what and why) and @docs/lld.md (how). The code must match the LLD; if it can't, update the LLD in the same change and add an ADR to `docs/decisions.md`.
- API contract: `docs/api-spec.md`. Database: `docs/database.md` and `src/db/schema.sql`.
- Rules (always apply): @.claude/rules/architecture.md @.claude/rules/security.md
- Rules (apply when touching that area): `.claude/rules/coding-standards.md`, `testing.md`, `database.md`, `api.md`, `git.md`

## Commands
```bash
npm start          # app + simulators on http://127.0.0.1:3000
npm test           # all tests (node:test), must pass before any commit
npm run lint:sec   # security lint (also runs automatically after every edit via hook)
npm run reset      # delete the local SQLite DB
```

## Non-negotiables (stop and ask if a task conflicts with these)
1. **No third-party npm packages.** Node 22 built-ins only (`node:sqlite`, `node:crypto`, `node:http`, `node:test`).
2. **Never** log, store or return: UPI PIN, `credBlock`, binding token, raw ICCID, full mobile number, balances.
3. A payment must be signed by **the profile that owns the debited account**, and that profile's SIM must be present.
4. Never re-send `ReqPay`. Pending payments are resolved only by `ReqChkTxn` within NPCI pacing.
5. Only `src/modules/profiles.js` may change `profiles.state`.
6. AI (the routing advisor) only **orders** accounts that rules already marked eligible. It never decides eligibility or starts a payment.
7. Money is in integer paise. No floats for money.

## Workflow
Use the slash commands in order for any non-trivial change: `/plan` → `/architecture` (if the design changes) → `/implement` → `/test` → `/review` → `/security-review` → `/pr`. The matching sub-agents are in `.claude/agents/`.

## Glossary
TPAP: third-party app provider (DuoPay). PSP: sponsor bank. VMN: virtual mobile number receiving the binding SMS. CL: NPCI Common Library (captures the PIN). VPA: UPI address. MSISDN: mobile number. ICCID: SIM serial.
