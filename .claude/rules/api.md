# API rules

- The contract is `docs/api-spec.md`. Change the spec and the code in the same commit.
- Paths are versioned (`/v1/...`), nouns, plural. Actions that aren't CRUD use a sub-resource verb (`/payments/{id}/check-status`).
- Request and response bodies are JSON, `camelCase`. Money is `…Paise` integers. Times are ISO-8601 UTC.
- Errors: `{"error": {"code", "message"}}` using codes from LLD §7 with the listed HTTP status. Add new codes to LLD §7 first.
- Validate input at the route boundary (types, ranges, VPA format `^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$`, amount 1…`TXN_LIMIT_PAISE`). Reject unknown fields on payment endpoints.
- Every signed response includes `simCheck`, so the app learns about suspended profiles immediately.
- `POST /v1/payments` must require `Idempotency-Key` and return the stored transaction on a replay with the same body.
- Never return internal ids of other installations, encrypted values or hashes.
