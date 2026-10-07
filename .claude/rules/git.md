# Git rules

- Branches: `feat/<short-name>`, `fix/<short-name>`, `docs/<short-name>`, `sec/<short-name>`.
- Commits: Conventional Commits, e.g. `feat(payments): enforce profile signature on pay`. Use the imperative mood, ≤72 characters in the subject.
- One logical change per commit. Docs and tests go in the same commit as the code they describe.
- Before committing: `npm test` and `npm run lint:sec` must pass.
- Never commit `.env`, `data/*.db`, keys or real personal data.
- PRs use the template from `/pr`: summary, LLD sections touched, tests added, security checklist, screenshots for UI.
- Add a line to `CHANGELOG.md` under `Unreleased` for any user-visible or API change.
- No force-push to `main`.
