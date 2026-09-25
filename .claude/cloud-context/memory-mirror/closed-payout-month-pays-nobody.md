---
name: closed-payout-month-pays-nobody
description: "Both payroll read paths select outstation expenses by the trip's OWN payout_month/payout_year, and nothing carries a late approval forward — so approving a trip whose payout month is closed reimburses nobody, with no error and no marker."
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-07T22:27:54.814Z
  originSessionId: b5304e81-5cfa-4c7e-9c9e-2ba5b0804690
---

Measured on production `ozucdzovmcqvepbozvqf`, 2026-09-08 01:00 Cairo, while the owner was about to
spend a night clearing 240 pending trips worth **EGP 85,233**.

**The payout month is fixed when the row is written, and both readers filter on it exactly.**
`nextPayrollPeriod(record.date)` stamps payout = trip month + 1 at save time, so a March trip is a
April-payout row for ever, no matter when HR gets round to approving it. Both paths that decide what
payroll reimburses then pin themselves to the run's own period:

- `getApprovedExpenseTotalsForPayroll` — `.eq("payout_month", month).eq("payout_year", year).eq("hr_approved", true)`
- `loadPayoutExpenseTrips` in `automated-payroll/recommend.ts` — the same two `.eq`s

**There is no carry-forward for a late approval.** `automated_payroll_carry_forward` exists but is
overpayment RECOVERY (`recordOverpaidCarryForward`), not an unpaid-expense queue.
`imported_to_payroll_at` / `imported_payroll_batch_id` are a LOCK against editing a paid row, not a
list of work still to do — reading them as a queue is the natural misreading and it is wrong.

**So approving an old row changes its status and nothing else.** No error, no warning, no marker
anywhere that the money has nowhere to go. On 2026-09-08 the 240 pending rows carried payout months
2026-02 through 2026-06, and every `salary_batches` row for those months was `locked` or `approved`
— closed, paid, done. The 70 the owner had approved that same evening were payout 2026-07, also
closed. The only trips that could still reach an open run were the app-submitted requests, whose
payout months were 2026-09 and later.

**Why:** the queue shows a trip's decision state and says nothing about whether its payout month is
still open, so a full-looking backlog reads as work worth doing when part of it is unpayable by
construction. That is a screen problem, not a data problem — the rows are correct.

**How to apply:**
- **Before recommending anyone work an expense backlog, check the payout months against
  `salary_batches.status`.** A `locked` or `approved` batch means those approvals pay nobody.
- Approving them anyway is legitimate BOOKKEEPING (it clears the queue) but must never be described
  to the owner as paying anyone. On 2026-09-08 he confirmed the 240 were already settled by hand and
  had them cleared, each row stamped with its own month's note. Pre-image:
  `outstation_backup_20260908.expenses_pre_clear`.
- If a genuinely unpaid trip sits in a closed month, approving it is NOT the fix — it needs a
  deliberate decision about carrying it into the open run. Put that to the owner.
- Expenses for closed months were paid **by hand** into `salary_records.expenses` all along — see
  [[outstation-payroll-import-is-locked-out-by-batch-status]], which measured 361 rows and EGP 141k
  never once imported automatically. That is the same territory from the other end.

⚠ **A forensic trap that costs an hour.** `savePayrollExpenseApprovals` upserts the report's FULL
record set on every save, so `outstation_expenses.updated_at` is rewritten for every row in the
report each time anyone presses Save. **Only the LAST save is ever visible** — earlier ones leave no
trace at all, so "the timestamps show one save tonight" means "one save since the last one", never
"only one save happened". All 327 rows of the one imported report shared a single timestamp to the
second. See [[outstation-expense-payout-has-three-surfaces]] for the rewrite itself.

Related: [[outstation-expenses-two-data-models]], [[payroll-batch-membership-is-historical]],
[[a-payroll-rule-change-does-not-reach-an-already-open-run]].
