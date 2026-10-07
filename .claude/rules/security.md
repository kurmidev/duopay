# Security and compliance rules

These map to HLD §3 (constraints C1–C10) and §11 (threat model). When in doubt, choose the stricter option and note it.

## Data handling
| Never store, log or return | Store only as |
|---|---|
| UPI PIN, `credBlock` | nothing: pass through to the PSP once |
| Binding SMS token | SHA-256 hash |
| Raw ICCID | salted fingerprint computed on the device |
| Mobile number in clear | AES-256-GCM ciphertext + HMAC + masked form |
| Account balance (C4) | nothing |
| Full account number | masked (`XXXXXX1234`) + bank's opaque reference |

- Audit payloads use an allow-list of keys per event. Add keys deliberately.
- `console.log` of request bodies is banned in `src/` (the lint fails).

## Authentication
- Every `/v1/*` route (except installation registration) goes through `http/auth.js`: timestamp window, nonce, installation signature.
- Payments and profile removal also need the **owning profile's** signature. Never accept another profile's key.
- The SIM-state header is part of the signed string. Never read SIM state from an unsigned source.

## UPI protocol rules
- Device binding: one token per binding, ≥35 characters, 45 s expiry, 3 attempts per SIM per 24 h, random VMN, reject the same token from two numbers (C1).
- `ReqListAccount` only from the onboarding discovery endpoint, and it counts against the shared per-installation quota (C3, C5).
- Never re-send `ReqPay`. Status checks: ≤3 per transaction within 2 h, ≥90 s apart (C5).
- Profile must be `ACTIVE` and its SIM present at **both** the gateway and the orchestrator.

## AI
- The routing advisor receives only categorical and numeric features: no names, numbers, VPAs, notes or balances.
- Validate every model output (permutation check, number grounding). On any doubt, fall back to rules.
- The model never decides eligibility, limits or risk.

## Web
- Server binds to `127.0.0.1` by default. Security headers: CSP, `nosniff`, `no-store`, `frame-ancestors 'none'`.
- The UI escapes all dynamic text (`textContent`, never `innerHTML` with data).
- `/sim/*` and `/ops/*` exist only when `ENABLE_SIMULATORS` is on, and never in production.
