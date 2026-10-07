---
description: Prepare a pull request (checks, changelog, description)
argument-hint: [title]
---
Prepare a PR for the current branch. Title: **$ARGUMENTS** (Conventional Commit style; derive it from the commits if empty).

1. Run `npm test` and `npm run lint:sec`. Stop if either fails.
2. Make sure `CHANGELOG.md` has an `Unreleased` entry for user-visible or API changes.
3. Write the PR description:

```
## Summary
<what and why, 2-4 sentences>

## Design
LLD sections: … | ADR: … | API/DB changes: …

## Tests
<new tests, and which LLD §9 rows they cover>

## Security checklist
- [ ] No PIN / credBlock / token / ICCID / clear number / balance stored or logged
- [ ] Payment path still requires the owning profile's signature and SIM presence
- [ ] NPCI quotas and status-check pacing respected
- [ ] AI advisor inputs contain no PII; outputs validated
- [ ] /security-review run: <result>

## Screenshots (UI changes)
```
4. Show the description and the `gh pr create` command. Do not push without confirmation.
