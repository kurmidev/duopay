# Contributing to DuoPay

## Setup
Requires Node.js 22+. There are no packages to install.
```bash
npm test        # must be green
npm start       # http://127.0.0.1:3000
```

## Workflow (humans and Claude Code alike)
1. **Plan:** `/plan <change>`. Every change starts from the HLD/LLD.
2. **Design:** `/architecture` if components, flows, APIs or the schema change. Add an ADR to `docs/decisions.md`.
3. **Implement:** `/implement`, test-first.
4. **Test:** `/test`. Cover the LLD §9 rows plus negative cases.
5. **Review:** `/review`, then `/security-review`.
6. **PR:** `/pr`. CI equivalent: `npm test && npm run lint:sec`.

The rules every change must follow are in `.claude/rules/` (architecture, coding standards, testing, security, database, API, git). They apply to human contributors too.

## Definition of done
- [ ] Tests added and passing; `npm run lint:sec` clean
- [ ] LLD / API spec / database doc updated; ADR for design changes
- [ ] `CHANGELOG.md` updated under *Unreleased*
- [ ] Security checklist in the PR description ticked
- [ ] No new dependencies; no sensitive data stored or logged

## Reporting security issues
Don't open a public issue. Email the maintainers with steps to reproduce.
