---
description: Code review of the current diff against DuoPay rules
argument-hint: [base branch, default main]
---
Use the `reviewer` sub-agent to review `git diff ${ARGUMENTS:-main}...HEAD` (or the working tree if not on a branch).

Check, in order:
1. **Correctness:** does it do what the plan or LLD says? Edge cases: zero/negative amounts, IST day boundaries, concurrent requests, PENDING outcomes.
2. **Architecture:** layer rules and single-owner rules (`.claude/rules/architecture.md`).
3. **Tests:** new behaviour is tested; negative cases exist; tests are deterministic.
4. **Docs:** LLD, API spec, database doc and CHANGELOG are updated.
5. **Readability:** names, size of functions, comments explain *why*.

Output findings as a table: severity (blocker / major / minor / nit), file:line, issue, suggested fix. End with an overall verdict: approve / request changes.
