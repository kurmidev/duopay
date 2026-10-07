# DuoPay: Requirements

## Problem statement
UPI apps bind to one mobile number per device. Users with dual-SIM phones and bank accounts registered with different numbers can't pay from all of their accounts in one app. See HLD §1.

## Users
| Persona | Need |
|---|---|
| **Dual-SIM customer** | Pay from accounts registered with either SIM number without switching apps or re-registering |
| **Small merchant / gig worker** | Keep a work number and a personal number, each with its own bank, in one app |
| **PSP fraud and compliance team** | Every profile is as safe and as auditable as a normal single-SIM registration |
| **Support** | Clear reasons when a profile is suspended or a payment is pending |

## Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | Detect the phone's SIM slots and show which are active | Must |
| FR-2 | Create **one profile per active SIM number**, each via its own SMS device binding from that SIM | Must |
| FR-3 | SIMs on the same device **may belong to different people**; the only requirement is that the SIM is active (ADR-004) | Must |
| FR-4 | Discover and link bank accounts for each profile's number (onboarding only) | Must |
| FR-5 | Show all linked accounts in one list, labelled by SIM slot and masked number | Must |
| FR-6 | Pay a VPA from any linked account, validating the payee name first | Must |
| FR-7 | Suggest the best account for each payment, with a short reason; the user can override it | Should |
| FR-8 | Show why an account can't be used right now (SIM absent, daily limit, cooling-off, bank down) | Must |
| FR-9 | Suspend a profile immediately when its SIM is removed or the phone goes into airplane mode; reactivate it when the same SIM returns | Must |
| FR-10 | Deregister a profile when a different SIM is inserted in its slot | Must |
| FR-11 | Check the status of pending payments within NPCI pacing | Must |
| FR-12 | Let the user remove a profile | Must |
| FR-13 | Transaction history across all profiles | Should |
| FR-14 | Ops console: profiles, audit log, chain verification (prototype) | Should |

## Compliance requirements
| ID | Requirement | Source |
|---|---|---|
| CR-1 | Device binding per number: SIM active, no airplane mode, token ≥35 chars with 45 s expiry, 3 attempts/24h, random VMN, reject the same token from multiple numbers | NPCI (HLD C1) |
| CR-2 | Verify the SIM is active before UPI actions | NPCI (C2) |
| CR-3 | `ReqListAccount` only for linking during onboarding | NPCI OC-95 (C3) |
| CR-4 | Never store balances | NPCI OC-95 (C4) |
| CR-5 | API quotas: list account 25/app/day; status check ≤3 in 2h, ≥90 s apart | NPCI, Aug 2025 (C5) |
| CR-6 | PIN captured only by the NPCI CL | UPI spec (C6) |
| CR-7 | Data stored in India only | RBI 2018 (C7) |
| CR-8 | Consent for reading SIM information; purpose limitation; retention schedule | DPDP Act 2023 (C8) |

## Non-functional requirements
See HLD §12: latency, availability, data residency, audit retention, privacy, scale.

## Out of scope (v1)
iOS; setting or resetting the UPI PIN (`ReqRegMob`); UPI Lite, credit lines and mandates; QR scanning (VPA entry only in the prototype); real NPCI or PSP connectivity.

## Acceptance criteria (demo)
1. Bind SIM 1 and SIM 2 and link accounts from different banks to each. The accounts list shows all of them.
2. Pay from a SIM 2 account. Remove SIM 2: its accounts become ineligible ("SIM absent") while SIM 1's still work. Re-insert it: SIM 2 works again with the cooling-off cap.
3. Put a different SIM in slot 2: profile 2 is deregistered and must be re-bound.
4. Make a bank time out: the payment goes PENDING, status checks are paced, and the payment is never re-sent.
5. The audit chain verifies, and no PIN, token, ICCID, number or balance appears in the DB or logs.
