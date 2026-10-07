---
description: Turn a feature request or bug into an implementation plan tied to the HLD/LLD
argument-hint: <feature or bug description>
---
Plan the following change for DuoPay: **$ARGUMENTS**

Use the `planner` sub-agent. The plan must:
1. Restate the requirement in one paragraph, and list any ambiguity as questions (stop and ask if a question blocks the plan).
2. Name the HLD constraints (C1–C10) and threat-model rows it touches. Say "none" if none.
3. List the LLD sections and files to change, and say whether the LLD itself must change (if yes, `/architecture` is the next step).
4. Break the work into ordered steps of at most ~1 hour each, with a test for every step.
5. List risks and how each is checked.

Output the plan as a markdown checklist. Do not write code.
