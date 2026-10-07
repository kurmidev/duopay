# DuoPay: API specification (v1)

Base URL: `http://127.0.0.1:3000` (prototype). JSON bodies only. Money is in **paise** (integers).

## Conventions

- **Authentication.** Every `/v1/*` call except `POST /v1/installations` needs the signed headers from [LLD §3.2](lld.md#32-request-signing-httpauthjs): `X-Install-Id`, `X-Timestamp`, `X-Nonce`, `X-Sim-State`, `X-Signature`. Payment and profile removal also need `X-Profile-Signature`.
- **SIM state header.** `X-Sim-State` is base64url JSON `{"airplane": false, "slots": [{"slot": 1, "state": "READY", "fp": "<64 hex>", "carrier": "404-10"}, {"slot": 2, "state": "ABSENT"}]}`. It is part of the signed string.
- **SIM enforcement.** The SIM integrity check (LLD §4.3) runs **before** every signed handler, and its outcome is returned in `simCheck` on every response.
- **Idempotency.** `POST /v1/payments` requires an `Idempotency-Key` header (UUID).
- **Errors.** Every error looks like `{"error": {"code": "SIM_ABSENT", "message": "..."}}`. Codes and HTTP statuses are in LLD §7.

---

## Installations

### `POST /v1/installations` (unsigned)
Registers the app install and its device public key.
```json
// request
{ "publicKeyJwk": {"kty":"EC","crv":"P-256","x":"…","y":"…"}, "deviceModel": "Pixel 8", "integrityToken": "…", "consentSimRead": true }
// 201
{ "installationId": "ins_…", "simSalt": "hex32" }
```
`consentSimRead` must be `true` (DPDP purpose: device binding and SIM integrity), otherwise `VALIDATION`.

### `POST /v1/sim-state`
A heartbeat sent when the phone reports a SIM change. There is no body; it uses `X-Sim-State`.
```json
// 200
{ "simCheck": [ {"profileId":"prf_…","slot":2,"action":"SUSPEND","reason":"SIM_ABSENT"} ] }
```

## Bindings

### `POST /v1/bindings`
```json
// request
{ "slot": 2, "profilePublicKeyJwk": { … } }
// 201
{ "bindingId": "bnd_…", "token": "40-char one-time token", "vmn": "+919000000007", "expiresAt": "2026-10-07T17:00:45Z" }
```
Errors: `AIRPLANE_MODE`, `SIM_ABSENT`, `SLOT_ALREADY_BOUND`, `PROFILE_CAP`, `BINDING_LIMIT`.

The app must then send `token` as an SMS **from that slot** to `vmn`. In the prototype this is done with `POST /sim/telecom/sms`.

### `GET /v1/bindings/{id}`
```json
{ "status": "PENDING" | "VERIFIED" | "FAILED" | "EXPIRED",
  "failReason": null | "TOKEN_EXPIRED" | "TOKEN_MULTI_SOURCE" | "VMN_MISMATCH" | "SIM_NUMBER_MISMATCH" | "NUMBER_ALREADY_BOUND_ON_THIS_DEVICE",
  "profile": { "id": "prf_…", "slot": 2, "msisdnMasked": "70XXXXXX02", "vpa": "3f9a.2@duopay", "state": "BOUND" } }
```

## Profiles and accounts

### `GET /v1/profiles`
Lists every live profile on the installation, with its accounts.
```json
{ "profiles": [ { "id": "prf_…", "slot": 1, "msisdnMasked": "98XXXXXX01", "vpa": "…", "state": "ACTIVE",
    "coolingOffUntil": "…", "accounts": [ { "id": "acc_…", "bank": "BNKA", "bankName": "Bank A", "maskedNumber": "XXXXXX1234", "type": "SAVINGS" } ] } ],
  "simCheck": [] }
```

### `GET /v1/banks`
```json
{ "banks": [ { "code": "BNKA", "name": "Bank A", "status": "UP" } ] }
```

### `POST /v1/profiles/{id}/accounts/discover`
Runs `ReqListAccount` for **this profile's** number at one bank and links what it finds.
```json
// request
{ "bankCode": "BNKC" }
// 200
{ "accounts": [ … ], "profileState": "ACTIVE", "quota": { "used": 3, "limit": 25 } }
```
Errors: `PROFILE_NOT_ACTIVE` (profile suspended or deregistered), `QUOTA_EXCEEDED`, `BANK_DOWN`.

### `DELETE /v1/profiles/{id}`
Needs `X-Profile-Signature` for that profile. Returns `204`.

## Payments

### `POST /v1/payments/suggest`
```json
// request
{ "payeeVpa": "chaiwala@psp", "amountPaise": 25000 }
// 200
{ "payee": { "vpa": "chaiwala@psp", "name": "Ravi Tea Stall" },
  "source": "claude" | "rules",
  "reason": "Bank C: you usually pay this payee from it",
  "eligible": [ { "accountId": "acc_…", "profileId": "prf_…", "slot": 2, "bankName": "Bank C", "maskedNumber": "XXXXXX5678",
                  "score": 0.82, "headroom": { "amountLeftPaise": 9975000, "countLeft": 19, "coolingLeftPaise": null } } ],
  "ineligible": [ { "accountId": "acc_…", "slot": 1, "bankName": "Bank A", "reason": "SIM_ABSENT" } ],
  "simCheck": [] }
```

### `POST /v1/payments`
Headers: `Idempotency-Key`, `X-Profile-Signature` (signed by the profile that owns `accountId`).
```json
// request
{ "accountId": "acc_…", "payeeVpa": "chaiwala@psp", "amountPaise": 25000,
  "credBlock": "base64 from NPCI CL", "confirm": false, "suggestedRank": 1, "note": "tea" }
// 201 (or 200 when an idempotent replay returns the existing transaction)
{ "transaction": { "id": "txn_…", "status": "SUCCESS" | "FAILURE" | "PENDING", "rrn": "…", "failureCode": null,
                   "amountPaise": 25000, "payeeVpa": "…", "fromSlot": 2, "bankName": "Bank C" } }
```
Errors: `PROFILE_NOT_ACTIVE`, `INVALID_SIGNATURE`, `LIMIT_EXCEEDED`, `COOLING_OFF_LIMIT`, `CONFIRM_REQUIRED` (with `rules`), `RISK_BLOCKED`, `PAYEE_INVALID`, `BANK_DOWN`, `IDEMPOTENCY_CONFLICT`.

A wrong PIN is **not** an HTTP error. It is a `FAILURE` transaction with `failureCode: "INCORRECT_PIN"`, as in UPI.

### `GET /v1/payments?limit=20`
```json
{ "transactions": [ … ] }
```

### `POST /v1/payments/{id}/check-status`
```json
{ "transaction": { … }, "checksUsed": 2, "nextAllowedAt": "…" }
```
Errors: `STATUS_CHECK_TOO_SOON`, `STATUS_CHECK_LIMIT`, `VALIDATION` (transaction not PENDING).

---

## Simulator and ops endpoints (prototype only; disabled when `NODE_ENV=production`)

| Method & path | Purpose |
|---|---|
| `GET /sim/world` | Fictional SIM cards (ICCID → number), banks, which number has which accounts, demo PINs |
| `POST /sim/telecom/sms` `{iccid, to, text}` | Send an SMS from a SIM. The telecom adds the originating number and forwards it to the PSP |
| `GET /sim/npci/keys?bank=BNKC` | Issuer public key (SPKI, base64) for the NPCI CL |
| `POST /sim/banks/{code}/mode` `{mode: "UP"|"DOWN"|"TIMEOUT"}` | Make a bank fail or time out (to demo PENDING) |
| `GET /ops/audit` | Audit ledger plus chain verification result |
| `GET /ops/profiles` | All profiles (masked) for the ops console |
