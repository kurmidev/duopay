# Coding standards

- **Runtime:** Node.js 22, ES modules (`import`/`export`), no TypeScript build step. Use JSDoc on exported functions.
- **No dependencies.** Built-ins only. Check `node:` modules before writing a helper.
- **Style:** 2-space indent, single quotes, semicolons, max ~120 columns. `const` by default. No classes unless state is needed.
- **Naming:** `camelCase` functions/variables, `UPPER_SNAKE` constants and error codes, `snake_case` DB columns. IDs use prefixes (`prf_`, `acc_`, `txn_`).
- **Money:** integer paise everywhere (`amountPaise`). Format to rupees only in the UI (`Intl.NumberFormat('en-IN')`).
- **Time:** ISO-8601 UTC strings in storage. "Day" for limits means the **IST** calendar day (`lib/time.js`). Read the clock through `lib/time.js#now()` so tests can control it.
- **Errors:** throw `new AppError(CODE, message)` from `http/errors.js`. Never throw strings. Never leak stack traces to clients.
- **Functions:** small and pure where possible. Side effects (DB, PSP, audit) are at the edges of a module function and happen inside `db.tx()`.
- **Comments:** explain *why* (especially regulatory reasons, with the HLD constraint id, e.g. `// HLD C4: balances must not be stored`). Don't narrate *what*.
- **Randomness:** `crypto.randomBytes` / `crypto.randomInt` only. `Math.random` is banned in `src/` (the lint fails).
