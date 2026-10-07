---
description: Run and extend the test suite; map coverage to the LLD test plan
argument-hint: [area, e.g. payments | bindings | all]
---
Use the `tester` sub-agent for: **${ARGUMENTS:-all}**

1. Run `npm test`. If anything fails, report the root cause before changing code.
2. Compare the tests with the LLD §9 test plan for the area. List every plan row with no test.
3. Write the missing tests, prioritising negative and abuse cases (wrong profile key, SIM removed mid-flow, replay, quota exhaustion, limit races, AI output that breaks the guardrails).
4. Re-run and report: tests passed or failed, new tests, and LLD rows still uncovered.
