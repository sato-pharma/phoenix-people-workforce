---
name: one-part-employees-have-no-part-2-for-deductions-to-land-in
description: "one_part employees are paid entirely in Part 1, which is confirmed BEFORE the month ends — so their own month's deductions structurally cannot reach them; carry-forward to a later run is the designed answer, and a leaver has no later run."
metadata:
  node_type: memory
  type: project
---

Verified live on prod 2026-08-23 from `automated_payroll_runs`.

**The two-part rhythm is what makes month-end deductions work at all.** July's run:

| step | when |
| --- | --- |
| `part1_confirmed_at` | **2026-07-26** — during the month |
| month ends → collection runs | 1 August |
| `part2_confirmed_at` | **2026-08-08** — after the month |
| `published_at` → `salary_batches` | 2026-08-10 (batch `b4c3057e`, 105 rows) |

Deductions land in **Part 2**, which is confirmed *after* the month closes. That is precisely why
`isCollectableMonth` can refuse an unfinished month without breaking anything — for the 94
`two_parts` people there is always a later payment still to come.

**`one_part` (18 active) has no Part 2.** The whole salary sits in Part 1, disbursed before the
month ends and before collection can legally run. So a one-part employee's own-month deductions
have **nowhere to land, by design** — this is not a bug in the guard and must not be "fixed" by
weakening it. `src/lib/deductions/` never reads `payment_mode` at all; the split lives in
`src/lib/automated-payroll/split.ts` (`assembleParts`).

**The designed answer already exists: the carry-forward ledger.** `automated_payroll_carry_forward`
+ `src/lib/automated-payroll/carry-forward.ts` (owner decision **2026-07-25: carry forward, not
write off**). When Part-2 deductions push payable below the First Part already disbursed,
`assembleParts` clamps Second Part to 0 and reports `overpaidResidual`; the ledger records it and a
**later** run adds it to that employee's deductions. A run never consumes its own residual.

**The hole: a leaver has no later run.** Their residual is recorded and then sits unapplied
forever, because they never appear in a future assemble. Both entry doors are also shut on them —
collection is month-gated, and `app/api/admin/deductions/manual/route.ts` refuses anyone whose
`employment_status` is not `active`/`on_leave` (all 13 August leavers are already `resigned`).

**Why:** the owner hit this on 2026-08-23 and read it as the month guard being wrong. The guard is
right; the gap is that one-part and terminal employees have no later payment to carry into.

**FIXED for leavers 2026-08-23** (PR #2318, squash `5d121e3d`, live on prod — `/api/healthz` flipped
at 06:00 UTC / 09:00 Cairo). Two narrow doors beside the untouched month guard: the manual route now
admits a terminal employee **only** for the month their `last_working_date` falls in, and
`/api/admin/deductions/settlement` (+ `src/lib/deductions/settlement.ts`) runs one connector for one
leaver whose last working day has passed. The picker and a workspace panel were part of it — without
them the fix was unreachable from the UI. **The settlement path is INSERT-ONLY**: every connector
reconciles its category or source scope, so a draft set filtered to one employee would have
superseded every OTHER employee's candidates for that month. `tests/deductions-leaver-settlement.test.ts`
fails if `reconcileCandidateDrafts` ever appears there, and pins that `isCollectableMonth` is unchanged.

**August 2026's 13 leavers were NOT recovered** — the owner confirmed their settlements were already
paid before the fix landed, and a leaver has no later payment to bite into. The fix is for the ones
who come after.

**How to apply:** for an active `one_part` person, the correct handling is **carry to next month** —
never collect an unfinished month to reach them. For a leaver, the deduction must be netted against
the **final settlement before it is paid**, which needs a per-employee settlement collection scoped
to someone whose last working day has passed. Related:
[[deductions-collection-refuses-the-month-the-page-defaults-to]],
[[two-live-deduction-engines-p0]], [[resignation-full-pay-rule-is-resignation-only]],
[[payroll-batch-membership-is-historical]].
