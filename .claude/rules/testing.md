# Testing rules

- Framework: `node:test` + `node:assert/strict`. Files: `test/<area>.test.js`. Run with `npm test`.
- Each test builds its own app with `createTestApp()` (`test/helpers.js`): in-memory DB, fixed clock, fresh simulator world. Tests must not depend on each other or on wall-clock time.
- Use the **device helper** (`test/helpers.js#device`) to sign requests exactly like the real app. Don't call module functions directly when testing a security property; go through HTTP.
- Every bug fix starts with a failing test.
- Every LLD §9 test-plan row must have at least one test. When adding an LLD rule, add the test in the same change.
- Required negative tests for any payment-path change: wrong profile signature, SIM absent, replayed nonce, idempotent replay, limit exceeded.
- Assert on error **codes**, not messages.
- Never put real phone numbers, PANs or account numbers in fixtures. Use the fictional `simulators/world.js` data.
- AI advisor tests use a fake `fetch`. No network in tests.
