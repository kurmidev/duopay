# Database rules

- The source of truth is `src/db/schema.sql`. `docs/database.md` must be updated in the same change.
- Keep the DDL **PostgreSQL-portable**: standard types, `CHECK` constraints, partial unique indexes. No SQLite-only tricks in queries beyond `node:sqlite` itself.
- **Always use prepared statements with parameters.** String-built SQL is banned (the lint flags template literals passed to `prepare`).
- Every write that belongs to one business action goes in **one** `db.tx(() => …)`, including nonce insert and audit append.
- Limit checks read existing totals and insert the new row **in the same transaction**.
- Never add a column for: balances, holder names, PINs, tokens, raw ICCIDs or clear-text numbers (see security.md).
- Schema changes are additive (new nullable columns / new tables). Destructive changes need an ADR and a migration note in `CHANGELOG.md`.
- Money: `INTEGER` paise with a `CHECK (> 0)` where it applies.
- Timestamps: ISO-8601 UTC `TEXT` in SQLite (maps to `timestamptz`).
