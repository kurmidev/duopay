# Architecture rules

## Layers (imports only go downward)
```
http/        transport: routing, auth, error mapping. No business rules.
modules/     business logic. One module per LLD §4 section.
adapters/    interfaces to external parties (PSP). Modules call adapters, never simulators.
simulators/  fake telecom / PSP / NPCI / banks. Only adapters and dev-only routes import them.
lib/, db/    shared utilities and persistence.
```
- `modules/*` must not import `http/*` or `simulators/*`.
- `simulators/*` must not import `modules/*`. Each simulator owns its own fictional world.
- Cross-module calls go through exported functions, not shared mutable state.

## Ownership
| Concern | Only place it may live |
|---|---|
| Profile state changes | `modules/profiles.js#transition` |
| SIM presence decisions | `modules/simIntegrity.js` |
| Limits and NPCI quotas | `modules/limits.js` |
| Eligibility for payment | `modules/advisor.js#eligibility` (rules) + `limits` + `risk` |
| Talking to the PSP | `adapters/psp.js` |
| Audit writes | `modules/audit.js#append` |

## Design changes
- If you need to deviate from `docs/lld.md`, update the LLD and add an ADR (`docs/decisions.md`) in the same change.
- New external dependency: not allowed (see CLAUDE.md). Propose an ADR instead.
- Keep the profile model intact: **one profile = one SIM number**, never shared across slots or devices.
