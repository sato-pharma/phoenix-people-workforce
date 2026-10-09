# Taking a CRM or half-day deduction from the annual leave balance

The account behind the module rule in `.claude/rules/time-off.md` ("A CRM OR HALF-DAY DEDUCTION CAN
BE TAKEN FROM ANNUAL LEAVE INSTEAD OF SALARY"). The rule is the cue; this file is the evidence.

## What the owner asked for, 2026-10-09

In his own words: *"make a nother button if someone have a crm with no record or half day day to
instead of deducting from salary add a button deduct from leave balance/entitlment and this when
aoppers in his leave repor must show him the comment that i will write"*.

Four business facts were put to him as multiple choice, because each one changes what an employee is
actually charged:

| Question | His answer |
| --- | --- |
| Which balance | **Annual only** |
| Balance shorter than the deduction | **Take what is there, the rest from salary** |
| The comment | **Required, shown to the employee exactly as written** (no notification) |
| Undo | **Yes — a "Return to salary" button** |

## Where it lives on screen

`/admin/deductions`, on a CRM or half-day row: **Deduct from leave balance** and, once charged,
**Return to salary**. The employee reads the comment in the Vacation Report under "Taken from your
annual leave", rendered `whitespace-pre-wrap break-words` so his own line breaks survive.

## The split when the balance is short

`planLeaveBalanceCharge({ dueDays, coverableDays })` and
`decisionAfterLeaveBalanceCharge(…)` in `src/lib/deductions/leave-balance.ts`:

- **Fully covered** → the decision becomes `Do Not Take Action` with `appliedValue: null`. Nothing
  reaches payroll; the whole deduction is paid out of leave.
- **Partly covered** → the leave takes `coverableDays` and the decision becomes
  `Approved for Payroll` for the remaining salary days only.

The comment is **required**: the table's own check constraint refuses a blank or whitespace-only one,
so a charge cannot exist without the words the employee will read.

## One ledger, no function redefined — the load-bearing design choice

The days are inserted into **`attendance_annual_balance_charges`**, the same insert-only ledger the
weekly review already charges to, with `source = 'deductions'` and `deduction_candidate_id` set.

Every annual-balance reader sums that table's `days`, so all four count a deductions charge with **no
redefinition at all**. Each was read to confirm it before the migration was written:

| Reader | Where |
| --- | --- |
| `attendanceChargedDaysInPeriod` | TypeScript |
| `phx_attendance_balance_inputs` | SQL function |
| `phx_attendance_settle_digest_line` | SQL function |
| `phx_apply_vacation_paid_approval` | SQL function |

A **return** is not an edit or a delete — the ledger is immutable. It is a mirroring **negative** row
carrying `reverses_charge_id`, which nets itself out of every one of those readers.

`buildEmployeeEligibilityRows({ balanceCharges })` adds the charged days to `usedPaidDays`, so the
Entitlements tab and the portal tile agree with the Vacation Report.

## The guard that keeps salary and leave from both holding the same day

`recordDecision` refuses a CRM or half-day candidate that already has a live leave-balance charge
unless it is called with `viaLeaveBalance: true`, and says so in words: *"this deduction is taken
from the employee's annual leave balance. Press Return to salary first, then decide it."* The same row
is also excluded from the bulk-select tick list, so a select-all cannot fail the whole batch on it.

`chargeDeductionToLeaveBalance` writes the ledger row first and then records the decision; if that
decision write fails it immediately calls the return RPC, so the two can never both hold the day.

## The migration, and one real ordering hazard

`supabase/migrations/20261009200000_deductions_leave_balance_charges.sql` — **already applied to
staging and production** over `scripts/apply-sql-file.mjs`, each proved with a rolled-back
transaction: charge 1 day → balance `1.000`; a second charge on the same day refused with `40001`; a
blank comment refused with `22023`; return → `0.000`; production `rows_after_test = 0`.

It adds `source`, `deduction_candidate_id` and `comment`, makes `digest_line_id` and `settlement_id`
nullable, replaces `days_check` with a three-branch constraint (weekly-review charge · deductions
charge · reversal), narrows the employee-day unique index to
`where days > 0 and source = 'weekly_review'`, and adds the two `security definer` RPCs
`phx_deductions_charge_leave_balance` and `phx_deductions_return_leave_balance`, revoked from
public/anon/authenticated and granted to `service_role` only.

🔴 **Ordering hazard, stated in the migration header too:** production does not have dispute-center
section 7. If `20261009120000_dispute_center.sql` is applied **after** this file, it replaces
`days_check` with its own two-branch version and a deductions charge would then be refused.

## Proof

`tests/deductions-leave-balance.test.ts`, registered in `tests/run-tests.ts`.
