# Taking a deduction from the annual leave balance

The account behind the module rule in `.claude/rules/time-off.md` ("A DEDUCTION COUNTED IN DAYS CAN
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

## Widened the same day: Unpaid Vacation and Insufficient Balance Vacation

Hours after it shipped he asked for it on two more tabs, in his own words: *"also show the deduct
from balance in unpaid and insufficient"*. So the button now covers **four** categories — `crm`,
`crm_half_day`, `unpaid_vacation`, `insufficient_balance_vacation` — all of which are stored in
`days` on production (measured 2026-10-09: 47 live unpaid-vacation rows, 2 insufficient-balance).

**Four gates have to agree, so there is exactly one list.** `LEAVE_BALANCE_CATEGORIES` lives in
`src/lib/deductions/types.ts`, the one module in `deductions/` with no imports at all, because the
admin workspace is a client component and cannot import the charge service. It is read by:

| Gate | Where | What it refuses |
| --- | --- | --- |
| the button | `canTakeFromLeaveBalance`, `deductions-workspace.tsx` | shows nothing on a row it cannot charge |
| the decide guard | `recordDecision`, `service.ts` | deciding a charged row without `viaLeaveBalance` |
| the charge service | `assertChargeable`, `leave-balance.ts` | a category, or a row not counted in days |
| the database function | `phx_deductions_charge_leave_balance` | the same four categories, last word |

A tab that shows a button the server then refuses is the one failure mode worth designing against,
and the widening before this one had the list written out by hand in three of those four places.

**Why charging a vacation day does not double-count.** An unpaid vacation day is a day the annual
balance could **not** pay for — that is why it became a deduction candidate — so its
`v2_vacation_requests.paid_duration_days` is zero, and `requestDays` in
`phx_attendance_balance_inputs` (which every balance reader sums) does not count it. The charge
lands once, in `attendance_annual_balance_charges`. The day is in the leave ledger, but not as a day
the balance paid for, so taking it from the balance now consumes it exactly once.

`insufficient_balance_vacation` exists precisely because the balance was short, so `readLeaveBalance`
usually answers `no_balance` there and the dialog says "The employee has no annual leave balance left
to take this from." That is the right answer on that tab, not a defect; the button becomes usable
when the balance is there again — a new annual period, or days given back.

## The first-six-months override — without it the widening was decoration

**The widening above shipped refusing every row of the tab it was asked for.** Measured on production
the same day, after it merged: **every** live `unpaid_vacation` candidate is `first_six_months` — 16
in September 2026, 23 in August, 8 in July, with zero `missing_hire_date` among them. `readLeaveBalance`
refused that reason outright, so the new button on the Unpaid Vacation tab could not charge a single
row. The commit message even recorded the refusal as "the correct answer, not a fault".

Put to the owner as multiple choice, he chose **charge the accrued days and override the block**:

| Option | His answer |
| --- | --- |
| Charge the days he has ACCRUED so far, overriding the first-six-months block | **chosen** |
| Charge his whole first-year entitlement, past what he has accrued | no |
| Only a balance he may already use (refuses every row today) | no |

**The rule was never an absence of entitlement.** A first-year employee accrues
`firstYearAnnualEntitlementDays / 12` = **1.25 days per completed calendar month** from the hire date,
and `getVacationBalancePeriod` already returns that accrual — the six-month rule blocks *requesting*
paid leave. So someone hired 02 Aug 2026 has 1.25 days on 26 Sep 2026, enough for the one unpaid day
that otherwise costs 550 EGP of salary. The Super Admin pressing the button is deliberately spending
days the employee has already earned.

**It is opt-in, in one place.** `calculateVacationPayment({ allowFirstSixMonths: true })` skips the
gate; `calculatePaymentForRequest` passes the caller's flag straight through; the Deductions balance
read is the only caller in the system that sets it. Every leave request, every weekly review and every
payroll read still gets `first_six_months`, and `tests/vacation-calculations.test.ts` fails the moment
that leaks ("Requests before six months should be unpaid" — proven by removing the guard).

What stays refused: `missing_hire_date` (there is no period to accrue over), and a joiner with no
completed month, who has accrued nothing and falls through to the ordinary `no_balance` refusal. The
partial rule is unchanged — 3 days against 1.25 accrued charges 1.25 and leaves 1.75 on salary.

The dialog says so in words before anything is saved: *"Still inside the first six months, so this
spends days already accrued but not yet available to request."* It is worded neutrally like every
other string this app shows — `tests/neutral-wording.test.ts` turned the required `validate` job red
over the first draft of that sentence, naming the file and the line.

## Where it lives on screen

`/admin/deductions`, on any row of those four categories: **Deduct from leave balance** and, once
charged, **Return to salary**. The employee reads the comment in the Vacation Report under "Taken
from your annual leave", rendered `whitespace-pre-wrap break-words` so his own line breaks survive.

## The split when the balance is short

`planLeaveBalanceCharge({ dueDays, coverableDays })` and
`decisionAfterLeaveBalanceCharge(…)` in `src/lib/deductions/leave-balance.ts`:

- **Fully covered** → the decision becomes `Do Not Take Action` with `appliedValue: null`. Nothing
  reaches payroll; the whole deduction is paid out of leave.
- **Partly covered** → the leave takes `coverableDays` and the decision becomes
  `Approved for Payroll` for the remaining salary days only.
- **Partly covered on a row that was ALREADY cleared** → the leave takes `coverableDays` and the row
  **stays `Do Not Take Action`** with `appliedValue: null`. The remainder reaches no salary.

The comment is **required**: the table's own check constraint refuses a blank or whitespace-only one,
so a charge cannot exist without the words the employee will read.

## A cleared row can be charged — and the trap inside that

**The button refused a cleared row, which was the second thing standing between it and the tab it was
asked for.** On 2026-10-09 the owner pressed it and read back *"This deduction is already cleared —
there is nothing to take from the leave balance."* Measured the same minute: **9 of the 16** live
September `unpaid_vacation` rows are `Do Not Take Action`, Adel Eid Abdelrahman Mohamed Srour's — the
first row on his screen — among them.

His ruling: **let it charge the balance anyway.** Clearing a row stopped the salary deduction; whether
the employee keeps the leave day as well is a separate decision he makes per row.

🔴 **The load-bearing half is the PART-covered case, and getting it wrong moves money.** The split
above would have turned the uncovered remainder into `Approved for Payroll` — quietly reinstating a
deduction he had already waived, on a row he only touched to spend leave. So
`decisionAfterLeaveBalanceCharge` takes `alreadyCleared`, and such a row stays cleared whatever the
balance could pay; the preview reports those days as `uncollectedDays`, never as `salaryDays`.

Two things the dialog now says out loud, because neither is guessable from the row:

- the row is already cleared, so the charge costs a leave day and saves no money;
- **Return to salary puts it back to Pending, not back to cleared.** The prior decision is not
  recorded anywhere, so the undo cannot restore it — he re-decides the row.

**The same change closed a gap in the other direction:** the preview now runs the released-line check
the charge runs, so the dialog can no longer offer a charge the save then refuses with *"withdraw it
first"*. The button is already hidden on a pushed row, so this is the server agreeing with the screen
rather than a visible change.

## The report had to show the balance go down — the third thing in the way

Minutes after the cleared-row fix shipped he asked for the last half of it: *"make the entitlments of the
peoplw qho got this decrease by number of days"*, then *"in vacation report"*.

The charged days were already counted. `buildEmployeeEligibilityRows` adds them to `usedPaidDays`, so the
Entitlements tab Used column and the bar moved. **The Balance column did not** — and that is the number the
screen leads with (*“N days remaining”*, and *“Annual leave left”* on an employee own view). Inside the first
six months `calculateVacationPayment` returns `defaultUnpaid`, whose `balanceBeforeDays` is a hard **0**,
because that is the right answer when pricing a REQUEST. So a first-six-months row showed
`Entitlement 1.25 · Used 1 · Balance 0` — internally inconsistent, and identical to the row before the charge.
Since every live charge is on someone inside that window, the whole feature was invisible on screen.

**One figure changes, for EVERY row in that cohort.** Whenever the snapshot says `first_six_months` the
entitlement row reads the accrued balance off that snapshot — `roundDays(max(0, entitlementDays -
usedPaidDays))`, the annual path's own arithmetic on the two fields it already carries. Nothing else on
the row moves, and 🔴 **`allowFirstSixMonths` stays opt-in to the Deductions balance read ALONE**: an
earlier draft called the calculator a second time with a copy of the same six arguments, which left two
argument lists to keep in lockstep and put the flag in `vacation/service.ts`, where no leave request may
ever reach it. `tests/deductions-leave-balance.test.ts` refuses the string in that file outright.

🔴 **The first draft overrode it only for someone who ALREADY had a charge, and that moved the number the
wrong way.** An uncharged joiner stayed on `Balance 0` while a charged one read `0.25`, so pressing
*Deduct from leave balance* made the Balance column RISE from 0, and the colleague who had spent nothing
read poorer than the one who had spent a day. `Entitlement - Used` added up only on charged rows. Carrying
the accrued balance on every first-six-months row fixes both: `1.25` becomes `0.25` when a day is charged,
which is the decrease he asked to see, and two rows can be read side by side.

🔴 **What must NOT move with it, and is pinned separately:** `eligibilityStatus`, `daysUntilEligibility`,
`eligibleForAnnualPaidLeave` and `reviewFlags` all stay on the UNOVERRIDDEN snapshot. Passing the override
into the status would turn the badge from **First 6 months** to **Eligible** and drop the countdown — telling
HR that a joiner may take paid annual leave, which is the one thing the six-month rule exists to prevent.
An uncharged first-six-months row is left exactly as it was, so the only rows that move are the people he
charged.

🔴 **And Used has to count EVERY annual-balance pool, or the new figure overstates.**
`approvedPaidDaysInPeriod` — what prices a request — is `requestDays + balanceSettledDaysInPeriod +
attendanceChargedDaysInPeriod`, and that last one reads `attendance_annual_balance_charges` with **no
`source` filter**, so it counts the weekly attendance review's charges beside the deductions ones. The
Entitlements tab was handed `listLeaveBalanceChargesForEmployees` — the `source = 'deductions'` fold alone
— so a joiner who had accrued 1.25 days, been charged 1 by the weekly review and 0.25 by a deduction read
**Balance 1.00** on the report while `calculatePaymentForRequest` answered **0**. While the column was a
flat 0 for the cohort that gap was invisible; making it the headline figure made it a wrong headline.
`annualBalanceLedgerDays()` reads both pools in one pair of queries, with no `source` filter and no
employee filter (the ledger carries the same HR_ID case drift the per-employee readers use `ilike` for, so
the row builder matches on `hrIdsMatch`), and refuses a read past 20,000 rows rather than truncate it into
an understated balance.

🔴 **A FAILED ledger read is said on the tab.** Falling back to no rows leaves Used and Balance reading as
though nothing had been spent — the exact screen this feature exists to remove — and the charges section's
own banner is somewhere else entirely. `balanceChargesUnavailable` puts **“Balance charges could not be
read”** in every row's review flags instead.

🔴 **The accrued figure itself had to be right first.** `calculateMonthlyAccruedEntitlement` counted
month-BOUNDARY crossings: `(y2-y1)*12 + (m2-m1)` made 30 Sep → 01 Oct a whole month, so a joiner carried
1.25 days after ONE day of service while one hired on the 1st carried 0 after thirty. It counts COMPLETED
months now — the month lands when the hire day-of-month comes round, and on the last day of a shorter
month when it cannot (31 Jan completes 28 Feb) — which is the rule `.claude/rules/time-off.md` always
stated. Date-string arithmetic, because parsing to `Date` and reading `getMonth()` puts a UTC midnight
into Cairo's own day.

🔴 **The employee's own portal tile must NOT read that figure, and that is the other half of the fix.**
`getEmployeeAnnualLeaveBalanceDays` feeds `leaveDaysRemaining`, rendered as **“Annual leave left — N days”**
on the portal home and the Medical Rep command center. The accrued balance is the right answer for HR on the
report and the WRONG answer for the rep: the six-month rule still refuses every paid request —
`calculatePaymentForRequest` is never passed `allowFirstSixMonths` — and the tile links straight to the
request screen, which prices that day unpaid and shows **First 6 months**. Nothing in
`src/components/employee-portal` renders an eligibility caption beside the tile, so there is no second
figure there to make the first one honest. `requestableAnnualLeaveDays(row)` answers `row.annualBalanceDays`
only once `eligibleForAnnualPaidLeave` is true and `0` before that — which is what the tile read before this
feature existed. For an eligible employee the two figures are one number, so nothing moves for them.

Section 7 of `tests/deductions-leave-balance.test.ts` and section 2 of
`tests/portal-home-annual-leave-left.test.ts`. Each break was run and the named assertion watched firing:

| Break | What fired |
| --- | --- |
| override only the rows that already have a charge (the first draft) | *an uncharged first-six-months row shows what it has accrued, not a flat 0* |
| `requestableAnnualLeaveDays` hands the report figure to the tile | *a day the request flow refuses is not a day left* |
| the portal returns the row's Balance column straight | *must return the row's REQUESTABLE balance … never the raw entitlement* |
| the accrual counts month boundaries again | *one day of service has completed no month* |
| the charges read filters by `source` again | *the charges read must NOT filter by source* |
| the settlement pool is dropped | *every row comes back; the row builder nets and periods them* |
| the failed-read flag is removed | *a failed ledger read must be visible on the Entitlements row* |
| the override is called a second time | *the vacation service must never turn the override on for itself* |
| price the override as if nothing had accrued | *the charged day must come off the balance the Vacation Report shows* |
| let the override reach `eligibilityStatus` | *the override must not make him look eligible* |

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

`tests/deductions-leave-balance.test.ts`, registered in `tests/run-tests.ts`. Section 5 covers the
override, and each of its headline assertions was proven by breaking the fix and watching that
assertion — and only that one — fire:

| Break | What fired |
| --- | --- |
| drop `allowFirstSixMonths: true` from the deductions balance read | *the leave-balance read must ask for the accrued days* |
| make the gate ignore the flag | *the override must price the day instead of refusing it* |
| make the gate never apply (the override leaks) | *Requests before six months should be unpaid* — in `vacation-calculations.test.ts`, the suite that already owned that rule |

The override needs **no migration**: `phx_deductions_charge_leave_balance` re-checks the three figures
a concurrent writer could move, and has never held a six-month rule of its own.
