---
name: start-implementing-a-plan-agile-kazoo-phase5
description: "Phase 5 cutover — Deductions becomes the sole decision point, Automated Payroll goes read-only. Approved plan + owner decisions + what has shipped."
metadata: 
  node_type: memory
  type: project
  originSessionId: bd6c2994-f622-4563-b891-87464fa64cea
  modified: 2026-08-01T20:54:19.406Z
---

**Approved plan: `C:\Users\satoh\.claude\plans\start-implementing-a-plan-agile-kazoo.md`.**
Goal: `/admin/deductions` is the single place deductions are DECIDED;
`/admin/automated-payroll` becomes READ-ONLY for deductions.

## Owner decisions (2026-08-01) — do not re-litigate
1. **Day rate = Base ÷ ACTUAL calendar days, EVERYWHERE.** Payroll adopts the
   Deductions rule (payroll used ÷30 via `deductions-governance/calculations.ts`).
   Moves every day-based deduction ≈ −3.2% in a 31-day month, +7.1% in Feb.
2. **The payroll month is ROLE-DEPENDENT.** Head Office = 24th→23rd. Field force
   (Medical Rep, District Manager) = calendar month 1st→30/31.
3. **Installment follows pay mode.** One-part → deduct from FIRST part. Two-part →
   deduct from SECOND part. ⇒ no-record DOES apply to two-part employees, and
   **there is no `p2_no_record` step — it must be built.**

## Scope
MOVES (9 steps → 7 existing categories, **no schema migration**): p1_fingerprint,
p1_crm, p1_resignation_crm, p1_unpaid_vacation, p1_no_record, p1_other_deductions,
p2_vacation, p2_crm, p2_manual_deductions.
STAYS in payroll: New hires, Resignations, Special situations, Hold,
Non-employees, Hold review, Additions, Outstation expenses.

## 🔴 Architecture rule that everything hangs on
Wire the contract into **`recommendStep`, NEVER into `assembleRows`**. For a
cut-over category the recommender returns the published amount as
`row.recommended`; `confirmStep` snapshots `pick(draft, recommended)` into draft
rows as today. Wiring into `assembleRows` bypasses the confirm-time snapshot and
lets a Deductions edit silently move ALREADY-DISBURSED Part-1 money.

## Shipped 2026-08-01 — status CORRECTED late the same day (was recorded as "ALL UNMERGED"; 4 had merged)
| PR | State | What |
| --- | --- | --- |
| #1590 | **MERGED** `bfa9f1bb` | Probe chunked by URL BYTES not rows (crm keys reach 367 chars ⇒ 73KB URL ⇒ `fetch failed`), + employee NAME never HR code |
| #1592 | **MERGED** `6e1560df` | **A1: legacy `payroll-handoff` CLOSED** — the double-write guard. Both entry points gate; buttons hidden |
| #1593 | **MERGED** `9fb06730` | A2: `resolveCycleWindowForTitle` — role-aware month. 🔴 **STILL DEAD CODE: zero callers outside its own file. Nobody's month has changed.** |
| #1595 | **MERGED** `f6cc0a09` | C2: test-wiring guard — a file imported-but-uninvoked now fails the suite. Shipped `tests/test-wiring-complete.test.ts` ONLY |
| #1596 | **CLOSED, never merged** | C1 fake-postgrest as a TEST. Constructing the admin client poisoned the shared 519-file process (`validate` 3m30s → 20m17s, twice) |
| #1604 | **MERGED** `8e216497` | C1 redone as **`scripts/check-deductions-write-contract.ts`** — own process, so the memoized client dies with it. Verified running in CI as `validate` step 9 |

🔴 **`tests/helpers/fake-postgrest.ts` does NOT exist on `main`** — #1596 was
closed, and #1595 (despite the branch name `codex/tests-wiring-and-fake-postgrest`)
shipped only the wiring guard. Don't go looking for the helper.

**#1604 lesson worth keeping:** the gate had to be added to **`ci.yml` as its own
step**, not just to `check:harden` — see [[ci-does-not-run-check-harden]].
Both defect classes were proven to fire one assertion each at `ea404043`.

## 🔴 Discovered while planning — verify before relying on any of it
- **Carry-forward is marked recovered at Part-2 confirm but EXCLUDED from the
  publish re-assemble** (`run-service.ts:595` vs `:752` + `carry-forward.ts:73`).
  Debt written off in the ledger; deduction never reaches `salary_records`.
  Finance/FAB/CIB sheets omit it entirely. UNTESTED — traced statically only.
- **The step phase gate is one-directional** (`run-service.ts:318`). Part-1 steps
  stay writable during `part2`; ALL steps writable during `ready`. Publish
  re-assembles live ⇒ post-confirm edits DO reach payslips. The lock is UI-only.
- **`save()` failure does not abort `confirm()`** (`recommendation-step.tsx:323`
  vs `:334`) — HR's typed deduction silently replaced by the system recommendation.
- **`loans` is hardcoded 0** (`assemble.ts:214`); the Loan tab feeds `other_deductions`.
- **Deductions UI only sends decisionStatus + decisionReason**, and `recordDecision`
  is a FULL-ROW REPLACE ⇒ any `applied_amount` is wiped by the next status click.
- **`applied_value` and `applied_amount` are INDEPENDENT** — no days→amount recalc.
  `resolveDayBasedDeductionAmount` does exactly that and is DEAD CODE.
- **Vacation connector never sets `estimatedAmount`** ⇒ any approved vacation
  candidate blocks the WHOLE month's publish, with no in-app fix.
- `crm` has `requiresApproval:false` ⇒ Pending/Needs-Follow-up/Disputed CRM
  candidates PUBLISH by default.

## Test rules now in force (from the plan)
- **No expected value may be produced by importing the code under test.**
- **Every guard carries `// verified failing at <sha>`.** This rule immediately
  caught my own C2 guard, which checked `runner.includes(symbol)` — matching the
  import line itself, so deleting a `runTest()` call still passed.
See [[deduction-rules-are-written-in-comments-implemented-half]].
