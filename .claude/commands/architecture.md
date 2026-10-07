---
description: Update the design (HLD/LLD/ADR) before code when a change alters architecture, data or APIs
argument-hint: <change or plan reference>
---
Use the `architect` sub-agent to design: **$ARGUMENTS**

1. Read `docs/hld.md`, `docs/lld.md`, `docs/decisions.md` and `.claude/rules/architecture.md`.
2. Propose the smallest design change that satisfies the requirement and every HLD constraint. Show at least one alternative and why you rejected it.
3. Update, in this order:
   - `docs/lld.md` (modules, state tables, algorithms, error codes)
   - `docs/api-spec.md` and/or `docs/database.md` + `src/db/schema.sql` if contracts change
   - `docs/hld.md` only if components, flows or constraints change (Mermaid diagrams included)
   - a new ADR in `docs/decisions.md` (context, decision, consequences, compliance impact)
4. Summarise what changed and which tests `/implement` must add.

Do not write application code in this step.
