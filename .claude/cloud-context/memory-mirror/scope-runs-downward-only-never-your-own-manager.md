---
name: scope-runs-downward-only-never-your-own-manager
description: "Owner rule 2026-09-04 - scope runs DOWNWARD only: never your own manager, and never anyone at or ABOVE your own rank. A `line` basis is membership, not direction, so it put Product Manager B-155's manager (A-8, 57 real CRM visits) plus 10 DSMs, the RSM and a peer PM inside his scope. Enforced as a chain cut PLUS a seat-rank ladder. Read before changing resolveDoctorCoverageScope, any CRM board scope, or any rep/employee picker."
metadata: 
  node_type: memory
  created: 2026-09-04
  modified: 2026-09-04T14:10:40.313Z
  type: feedback
  originSessionId: 9f6cd802-11d9-4321-96a8-5fa6b16b21da
---

**The owner's words, 2026-09-04, in two turns.** First: *"Never an employee sees his direct manager.
You see yourself and your scope down — downgrading, not upgrading."* Then, asked how far the cut
should reach: *"remove dsms rsm and peer pms too."*

**Why:** a `line` scope is line MEMBERSHIP, which carries no direction at all — it is everyone who
happens to hold that line id. Measured in production the day the rule was given,
`resolveDoctorCoverageScope` gave Product Manager **B-155** a 57-person scope:

| seat | count | after the rule |
| --- | --- | --- |
| Medical Representative | 41 | **kept** |
| District Sales Manager | 10 | cut |
| National Sales Manager | 2 | cut |
| Product Manager (himself + a peer) | 2 | **himself kept**, peer cut |
| **Group Product Manager — A-8, his own direct manager** | **1** | cut |
| Regional Sales Manager | 1 | cut |

A-8 is not hypothetical: **57 real CRM visits**, 1 Jan → 27 Aug 2026, on the line he covers.

**THE DANGEROUS PART — it looked fine on screen, for two reasons that are not rules.** Signed in as
B-155 against a dev server, neither board showed her. Reps Plans carries an explicit
medical-reps-only filter that runs BEFORE scope, so she is dropped there deliberately. The KPIs
board has no such filter — only `isAgentInScope` — and she was absent from its 36 rows solely
because she has **0 plan entries**, so no row was built. The moment she files a plan, or a new board
lists agents without that medical-rep filter, a manager appears inside her own subordinate's view.
**Do not read "she isn't on the board" as "the rule is enforced".**

Her name does reach his browser once, and that one is legitimate: his own profile card,
`"fullName":"Ahmed Sharaf","manager":"Rasha Sabry"`. Ordinary self-service, not a scope leak.

**How to apply:** the stop belongs in `resolveDoctorCoverageScope`
(`src/lib/crm/doctor-coverage-scope.ts`), which IS the security boundary — never in whichever
downstream board remembers to filter. **Two independent cuts, because they catch different things:**

1. The viewer's whole **management chain** (walk `managerHrId` up, counting
   `pendingManagerReplacementForHrId` as an ancestor). Identity-based and **title-blind**, so it
   still catches a manager whose job title is misspelt or absent from the ladder.
2. A **seat-rank ladder** — keep only seats ranked **strictly below** the viewer's own.
   Medical Representative 1 · District Sales Manager and Product Manager 2 · Regional Sales Manager
   and Group Product Manager 3 · National Sales Manager 4. Both vocabularies are listed, because the
   app ROLE and the employee JOB TITLE differ ("Medical Rep" vs "Medical Representative"). The
   viewer is ranked by his **role**; everyone else by their **job title**.

🔴 **A FLAT LIST OF BANNED TITLES IS THE WRONG SHAPE, and it is the obvious first attempt.** The
`line` basis serves all three `LINE_ROLES`, and a District Sales Manager is upward from a Product
Manager but **downward from a National Sales Manager** — so blocking DSM/RSM/peer-PM by title would
delete an NSM's own reports and hand him `finalizeAgents`' *"No active employees are recorded on
your product line"*. Same failure shape as
[[the-ceo-is-not-a-district-and-a-picker-is-not-wider-than-its-viewer]], where the damage was also
an empty board that reads as a data fault rather than a bug.

🔴 **THE VIEWER IS NEVER EXCLUDED FROM HIS OWN SCOPE** — an NSM is not strictly below himself, and
without that guard the ladder empties his board the same way.

🔴 **An UNRANKED title is EXCLUDED from a line scope, and that is deliberate.** 12 head-office seats
carry a `line_id` in production — the CEO, HR, Finance, QPPV, R&D, even "Buffet" — so "unknown means
field force, keep them" would put the CEO inside a Product Manager's scope. Lines 1–3 are the field
lines and every title on them is ranked; line 4 holds those office seats and has no line-scoped
viewer at all.

**The ladder runs on the `line` basis ONLY.** A team scope (DM/RM) is already provably downward,
walked out of the org tree, and ranking it would drop a report whose title is off the ladder (an
Admin Assistant under a DM) out of his own manager's board. The chain cut runs on both.

**Measured on the live directory:** B-155 **57 → 42**, A-10 **33 → 25**, GPM A-8 **24 → 22**, and
all three National Sales Managers **unchanged** (33 / 34 / 24). Pinned by
`runDoctorCoverageScopeTests` in the required CI `validate` job — including a runtime assertion that
every `LINE_ROLES` entry is ranked, because an unranked one does not error, it silently restores the
wide pre-2026-09-04 board.

Related: [[a-matrix-grant-is-only-gate-one-of-two]] ·
[[acting-dm-authority-is-app-role-not-job-title]]
