---
name: automated-payroll-notice-period-population-bug
description: "Real payroll bug found+fixed 2026-07-25: an employee serving a notice period into a FUTURE month (employment_status already 'resigned' but last_working_date later) was silently dropped from the ENTIRE Automated Payroll population for every month before their actual exit — no error, no empty state, just missing pay. Fixed via isAfterPeriod in recommend.ts. Confirmed live against real case B-157 (Sameh Ahmed Ezzat Mohamed Hussien)."
metadata:
  node_type: memory
  type: project
  originSessionId: a18d5dc4-6334-443d-9a12-4265945f4a9c
  modified: 2026-07-25T11:37:46.644Z
---

Found while the owner asked about one specific employee ("Sameh Ezzzat is resigned but his resignation date is 31 August so he must be shown in the sheet... his payment is already done but put in the sheet for correct total calculations"). Investigated rather than building a bespoke one-off flag, and found a real structural bug — worth remembering the pattern, not just the one fix.

**Root cause.** `resolvePayrollPopulationAndSources` (`src/lib/automated-payroll/recommend.ts`) excluded any employee with a terminal `employment_status` (resigned/terminated/etc, via `isPayrollIneligibleEmployee`) UNLESS `buildFeederStates`'s `leaverLastWorkingDate` was set — and that's only set when the resignation's `last_working_date` falls INSIDE the exact period being processed (`employee_resignations` query has `.gte(start).lte(end)`). `employment_status` flips to "resigned" the moment a resignation is approved — typically well before the employee's actual last day, since HR usually enters a resignation with a future last-working-date (notice period). Result: for every month between "resignation approved" and "actual last day," the employee was silently excluded from the ENTIRE population — every Part 1/2 step, no error, no empty-state message, nothing to notice by. They just never got a payslip computed for those months.

**Verified against production 2026-07-25:** exactly one employee currently in this state — B-157, Sameh Ahmed Ezzat Mohamed Hussien, `employment_status='resigned'`, `resignation_date`/`last_working_date`='2026-08-31', `payment_mode='one_part'`. For the active July 2026 run he was completely absent from all 117 (now 118) population rows before the fix.

**Fix:** added `isAfterPeriod(dateText, period)` — true when a date's year-month is strictly after the given period — and changed the population-inclusion guard from `isPayrollIneligibleEmployee(employee) && !isLeaver` to also exempt `isAfterPeriod(employee.lastWorkingDate, period)` (using the employee's OWN `lastWorkingDate` field, already exposed on `EmployeeDirectoryRow` — no new query needed). Such an employee gets `lifecycle: "regular"` (not leaver, not joiner) and is computed as a completely normal active employee for that month. **Confirmed live** via a read-only GET against the real July run: Sameh now appears with `lifecycle: "regular"`.

**What this does NOT need — resist building bespoke machinery.** The owner's actual ask ("show already-paid-elsewhere employees in the sheet, counted in totals, but flagged so nobody pays them again") maps EXACTLY onto the existing Hold mechanic, already built: held employees stay in every reconciliation total (`reconcile()` sums all rows unconditionally) but are excluded at `publishToPayslips` (`rows.filter(entry => !entry.onHold)`), with a free-text `holdReason` HR can use to explain why. No new flag/feature was needed for that half of the ask — just toggle Hold with a reason once the employee correctly appears (which required the population fix above). Recognizing this saved building a whole parallel "already paid" state that would have duplicated Hold's exact semantics.

**Guard test:** `tests/automated-payroll-part1-scope.test.ts`, using B-157's real shape (2026-08-31 vs July 2026 period) plus edge cases (same-month exit stays excluded via the leaver path instead, earlier-month exit stays excluded, year-boundary case, no-date case). Verified it actually fails when the predicate is broken (returned `false` unconditionally), then reverted.

**Not yet committed** as of this writing — bundled with the same-session search-box addition (see [[automated-payroll-part1-other-deductions-4tabs]] and related session memories for the rest of that day's Automated Payroll work).
