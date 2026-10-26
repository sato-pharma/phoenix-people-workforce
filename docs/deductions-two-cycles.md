# Deductions — the two collection cycles

## Why

Part 1 of the salary is paid before the month ends. The Deductions module only collects a month
that has finished (the guard behind the 2026-08-03 incident, 39,225.73 EGP charged for days not yet
worked), so it could never feed a Part 1 salary in time.

The owner's ruling, 2026-10-26:

- Employees paid in **one part** (`payment_mode` one_part, read through the employee directory's
  `salaryPaymentMode`) are judged over the **Head Office cycle**, the 22nd of the previous month to
  the 21st of the payroll month. His words were "22 to 20". A cycle has to be contiguous, or the 21st
  of every month would never be judged, so it is read as 22 → 21, and he was told so. He first kept
  one-part sales managers and reps on the calendar month, then reversed that in his final word
  ("make anyone part one to be from 22 to 20"). Every one-part employee is on the office cycle,
  field force included.
- Employees paid in **two parts** stay on the **calendar month**, 1st to last day.
- Every employee is on exactly one cycle.

## The cutover

The office cycle starts with the **October 2026** payroll month. September 2026 was collected on the
calendar month for everyone, so October's office window is **1 → 21 October**. Opening it on
22 September would charge 22–30 September a second time. From November on, the window is the plain
22nd → 21st, for example 22 October → 21 November.

Before October 2026, the calendar run covers everyone and there is no office window. `cycleWindow`
throws if asked for one.

## How it works

`src/lib/deductions/cycle.ts` holds all of the rules. It is pure: no database access and no clock.

- **Collect.** The Deductions screen shows a *Cycle* select (Head Office or Calendar month) for
  October 2026 onward. A Head Office run:
  - runs each connector for every calendar month the window touches;
  - keeps only the one-part employees;
  - clips each draft to the window, scaling its days and amount by the fraction of days kept;
  - re-keys each draft to the payroll month;
  - merges a record that spans both months into one row.

  If the two halves claim the same day, the row goes to review with no amount; it is never summed
  twice. The window can be collected only after its 21st has ended in Cairo, and the button is
  disabled until then.
- **Population.** From the cutover, the calendar run drops one-part employees before reconciling,
  and each run reconciles only its own population. A run never retires the other cycle's rows. An
  unreadable employee directory refuses the run instead of charging anyone twice.
- **Validation.** A row keyed to month P may carry dates outside P only when its evidence marker
  names exactly the office window `cycle.ts` computes for P. A marker naming any other window holds
  the row to its own calendar month.
- **Already charged?** An office row for November carries 22–31 October. Every read that asks
  whether a day is already charged therefore covers the month and the next one
  (`ledgerClaimMonthKeys`), matching by date. That includes the five connectors, the leaver
  settlement and the HR Ops bridge report's claim read.
- **Cross-cycle hold.** A day a live row of the same person and category already carries under a
  DIFFERENT month key holds the new draft (`holdCrossCycleClaimedDrafts` in `collect.ts`), with a
  note naming the person, the claimed days and the open days. It runs on every office run, and on
  the calendar run from the cutover. A draft already live under its own month is kept, so the
  reconcile never retires it. HR's own manual rows never hold anything.
- **Reconcile window.** An office run reconciles only the rows whose every date falls inside its
  window (`scope.dateWindow`), so it never retires a row it could not have produced.
- **Employee Day Report.** A day HR adds from the day report lands on the payroll month the
  employee is paid in (`dayChargeTarget`): a one-part employee's day after the 21st goes to the
  next month's row, carrying the office marker; everyone else, and every day before October 2026,
  stays on its calendar month. The amount is still priced on the day's own calendar month. Before
  adding a row it looks for one that already holds the day in both month keys.
- **Leave balance.** "Deduct from leave balance" charges at a day inside the row's own payroll
  month. January's row starts in December, and anchoring there would draw on last year's balance.

## Known edges, not changed (payroll formulas are the owner's)

- The leaver CRM clamp in `automated-payroll/recommend.ts` (about line 1667,
  `Math.min(daysWorked, chargeableDays)`) counts only the payroll month's days. A one-part leaver's
  22nd–31st days from the previous month can therefore be undercharged.
- Payroll prices a day as Base ÷ the days in the payroll month (`recommend.ts` about 1535–1556,
  `calculations.ts` about 260). An office row's clipped amount is priced per the connector's
  calendar month, so the two can differ by piasters once HR edits a row.
- The per-month day-collision gates (`conflict.ts`, the publication trigger, `duplicate-days.ts`,
  `day-overlap.ts`) group by month. Across months, the claim reads and the cross-cycle hold above
  are the guard.
- The HR Ops bridge keys its field-review rows to the calendar month. A one-part employee's field
  day after the 21st therefore lands on (or is refused for) its calendar payroll month rather than
  the next one. It is never charged twice: the bridge's claim read covers both months.
- The CRM connector seeds its suspect dates against UTC "today" (`crm.ts` about line 193), not
  Cairo. This predates the cycle work.
- Not covered by this change's review: the settlement write side for one-part leavers, the
  employee portal's month display, and the database trigger body.

Pinned by `tests/deductions-cycle.test.ts` and `tests/deductions-current-month-guard.test.ts`.
