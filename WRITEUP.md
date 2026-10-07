# Write-up: DuoPay, a multi-SIM UPI app

> **Draft for you to edit.** Everything below happened while this was built. The parts marked ✏️ need your own words, because the interview will probe them.

## What I built and why

DuoPay is a UPI app that creates **one verified UPI profile per active SIM** in a dual-SIM phone, and lets the user pay from every bank account linked to any of those numbers. Today a UPI app binds to a single number, so accounts registered with the second SIM's number are unreachable without re-registering or installing another app.

The deliverables:
- a High-Level Design (constraints, architecture, 9 diagrams, threat model);
- a Low-Level Design (modules, algorithms, signing scheme, API, DDL);
- a Claude Code engineering setup (`.claude/` rules, commands and agents);
- a working prototype: a phone simulator with two SIM slots, the app, simulated telecom/PSP/NPCI/banks, and 54 tests.

✏️ *Why this problem: your own experience with two SIMs, or someone you've seen hit this.*

It also fits the role: a payments product, where the hard part is compliance and security rather than screens. That is exactly the judgement a tech lead is hired for.

## AI tools and the role each played

| Tool | Role |
|---|---|
| **Claude (agent with web search, shell and browser)** | Researched NPCI/RBI/DoT/DPDP rules; wrote the HLD and LLD; wrote the code and tests; drove a headless browser for end-to-end runs and screenshots; rendered the design PDFs |
| **Claude Code workflow (`.claude/`)** | `CLAUDE.md` + 7 rule files define the non-negotiables. 7 slash commands chain plan → architecture → implement → test → review → security-review → PR. 6 sub-agent definitions. A hook runs a security lint after every edit |
| **Independent security-reviewer sub-agent** | A separate agent with read-only access that hadn't seen the code being written. It audited the repo adversarially and proved its findings with scripts |
| **Claude API, inside the product** | The routing advisor ranks the accounts the rules allow, and explains its choice in one line. Forced tool call, validated output, rules fallback |

## How AI influenced key decisions

1. **I threw away the first project.** The AI's first build was an engineering-standup tool. I judged it weak for this role and pivoted to my own idea. ✏️ *one line on why.*
2. **Compliance research reshaped the AI feature.** My first instinct was "suggest the account with the most balance". Research surfaced NPCI circular OC-95: a TPAP may not store balances, and may call list-accounts only while linking. So the advisor uses only lawful signals: daily limit left, bank reliability and payee habit. **Rules decide eligibility; the AI only orders.**
3. **I overrode the AI on a compliance trade-off.** The AI proposed a same-owner check, because one phone running many people's numbers is a mule-account pattern. I decided the second SIM just has to be active. The AI recorded this as ADR-004, with compensating controls (device-wide velocity limits, a profile cap, an audit trail) and an open item for the PSP's fraud team.
4. **Design-first workflow.** HLD and LLD came before code. The code was then checked against the LLD's test plan (§9), and every deviation found during the build was written back into the docs and ADRs.

## Where AI surprised me / changed my approach

- **Writing tests exposed a hole in the design.** A test sent the binding SMS from a SIM in *another* phone, and the bind succeeded. The SMS proves you own *a* SIM with that number, not that it's in this phone. The response was ADR-010: an operator cross-check now, and a telco number-verification API before production.
- **The independent reviewer found 2 high-severity bugs the builder missed**, and caught that ADR-010 itself relied on data the phone reports, which a tampered app can fake:
  - concurrent bindings could exceed the profile cap;
  - rotating the SIM fingerprint reset the "3 attempts per 24h" limit.

  All 10 findings are fixed or documented, each with a regression test ([security-review.md](docs/security-review.md)). **Lesson:** AI-written code needs an AI (or human) reviewer that didn't write it.
- **The security-lint hook caught violations as they were written:** SQL built with template literals (harmless constants, but against the rule) was flagged as soon as it was written, and fixed before it spread.
- ✏️ *Your own surprise from running it: e.g. what Claude's ranking said once you added an API key.*

## Results

- **Tests:** 54 automated tests pass, covering binding, SIM integrity, payments, limits, the AI guardrails, security and the review regressions.
- **Live run:** a browser walkthrough with no console errors. Removing SIM 2 pauses only SIM 2's accounts.
- **Not yet done:** the advisor's Claude path is tested with a fake model, because the build environment couldn't reach the API. ✏️ *Run it with your key and note the result.*

## What I'd do next as a tech lead

The priorities are in [roadmap.md](docs/roadmap.md):
- an Android client (per-subscription SMS, Android Keystore, Play Integrity);
- a telco number-verification API;
- PostgreSQL;
- NPCI and PSP approval for multiple profiles per device.

✏️ *How you'd staff and sequence it, and what you'd measure in a pilot.*
