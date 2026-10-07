---
description: Implement an approved plan step by step, test-first
argument-hint: <plan step or feature>
---
Use the `developer` sub-agent to implement: **$ARGUMENTS**

For each plan step:
1. Write or extend a failing test in `test/` (see `.claude/rules/testing.md`).
2. Implement the smallest change that makes it pass, following `.claude/rules/coding-standards.md`, `architecture.md`, `security.md`, `database.md` and `api.md`.
3. Run `npm test` and `npm run lint:sec`. Fix until both are green.
4. Keep the docs in sync (the LLD, API spec and database doc describe the code exactly).

Stop and ask if the work would require: a new npm package, storing any data on the security "never store" list, changing `profiles.state` outside `profiles.js`, or re-sending `ReqPay`.

Finish with: files changed, tests added, anything left undone.
