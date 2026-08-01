import assert from "node:assert/strict";

import {
  distributeAmount,
  formatDateRange,
  leaverVisitTypeStatus,
  weekdayName,
} from "../src/lib/automated-payroll/recommend.ts";
import { STEP_DEFINITIONS, stepWindowLabel } from "../src/lib/automated-payroll/step-definitions.ts";

/**
 * Guards the read-only per-line breakdown added to the three Part-2 feeder steps
 * (owner request 2026-08-01: "which days in expenses, where, and any other
 * relevant detail").
 *
 * Two things must hold for a breakdown on a payroll screen to be worth showing:
 *
 *  1. It must FOOT. The row's money is computed once for a whole group
 *     (Base/30 × days); the panel shows it per day. Rounding total/count per
 *     line makes 1,400.00 display as 3 × 466.67 = 1,400.01, and a breakdown that
 *     disagrees with its own total destroys trust in the number it explains.
 *     distributeAmount is the only thing standing between those two figures.
 *
 *  2. It must say WHICH DAYS, honestly. The three steps sit next to each other
 *     and cover three DIFFERENT windows — verified against production
 *     2026-08-01, where rows tagged payout_month=7 carry expense_date in June.
 *     stepWindowLabel is what stops a correct figure from looking wrong.
 */

export function runAutomatedPayrollStepDetailTests() {
  // ---- distributeAmount: the breakdown must always foot to the row total ----
  assert.deepEqual(distributeAmount(1400, 3), [466.67, 466.67, 466.66], "the last line absorbs the rounding remainder");
  assert.equal(
    distributeAmount(1400, 3).reduce((sum, part) => sum + part, 0),
    1400,
    "3 days of a 1,400 deduction must sum back to exactly 1,400 — not 1,400.01",
  );

  // Cases picked to force a remainder in each direction, plus clean divisions.
  for (const [total, count] of [
    [1400, 3],
    [1000, 3],
    [466.67, 7],
    [0.01, 2],
    [12813, 29],
    [903.23, 2],
    [30986, 19],
    [100, 4],
  ] as const) {
    const parts = distributeAmount(total, count);
    assert.equal(parts.length, count, `distributeAmount(${total}, ${count}) must produce one part per line`);
    const summed = Math.round(parts.reduce((sum, part) => sum + part, 0) * 100) / 100;
    assert.equal(summed, total, `distributeAmount(${total}, ${count}) must sum back to the exact total`);
  }

  assert.deepEqual(distributeAmount(500, 1), [500], "a single line carries the whole amount");
  assert.deepEqual(distributeAmount(500, 0), [], "no deducted days -> no lines, never a divide-by-zero");
  assert.deepEqual(distributeAmount(500, -2), [], "a negative count must fail closed to no lines");
  assert.deepEqual(distributeAmount(0, 3), [0, 0, 0], "a zero deduction spreads as zeros, never NaN");

  // ---- formatDateRange: an overnight trip spans days; a day trip does not ----
  assert.equal(formatDateRange("2026-06-01", "2026-06-02"), "2026-06-01 → 2026-06-02", "overnight stays must show both ends");
  assert.equal(formatDateRange("2026-06-01", "2026-06-01"), "2026-06-01", "a same-day trip must not render as a fake range");
  assert.equal(formatDateRange("2026-06-01", ""), "2026-06-01", "a missing to_date falls back to the start date");
  assert.equal(formatDateRange("", ""), "—", "no dates at all renders an em dash, never 'undefined'");
  assert.equal(
    formatDateRange("2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z"),
    "2026-06-01 → 2026-06-02",
    "timestamps are trimmed to the date part",
  );

  // ---- weekdayName: lets HR spot a flagged day that was a weekend -----------
  assert.equal(weekdayName("2026-06-01"), "Monday");
  assert.equal(weekdayName("2026-08-01"), "Saturday");
  assert.equal(weekdayName(""), "", "an unparseable date yields no weekday rather than 'Invalid Date'");
  assert.equal(weekdayName("not-a-date"), "");

  // ---- stepWindowLabel: the three windows are genuinely different ----------
  const july = { month: 7, year: 2026 };

  // The CRM step reads the day-24 cycle, so a late-June absence lands on the
  // July sheet. This is the single most confusing thing about the step.
  const crmLabel = stepWindowLabel("p2_crm", july) ?? "";
  assert.match(crmLabel, /2026-06-24/, "the July CRM step starts on 24 June, not 1 July");
  assert.match(crmLabel, /2026-07-23/, "the July CRM step ends on 23 July, not 31 July");
  assert.match(crmLabel, /not the calendar month/, "the label must say out loud that this is not the calendar month");

  // Year rollover: January's cycle must reach back into the previous year.
  const januaryCrmLabel = stepWindowLabel("p2_crm", { month: 1, year: 2026 }) ?? "";
  assert.match(januaryCrmLabel, /2025-12-24/, "January's cycle starts 24 December of the previous year");
  assert.match(januaryCrmLabel, /2026-01-23/);

  // Vacation IS the plain calendar month — and must differ from the CRM window.
  const vacationLabel = stepWindowLabel("p2_vacation", july) ?? "";
  assert.match(vacationLabel, /2026-07-01/);
  assert.match(vacationLabel, /2026-07-31/, "July has 31 days");
  assert.notEqual(vacationLabel, crmLabel, "vacation and CRM must never claim the same window");
  assert.match(
    stepWindowLabel("p2_vacation", { month: 2, year: 2026 }) ?? "",
    /2026-02-28/,
    "February 2026 is not a leap year",
  );

  // Expenses is a finance TAG, not a date range — the label has to say so,
  // because the trips themselves are routinely from an earlier month.
  const expensesLabel = stepWindowLabel("p2_expenses", july) ?? "";
  assert.match(expensesLabel, /July 2026/, "the payout tag is named by month, not by date range");
  assert.match(expensesLabel, /often earlier/, "must warn that the trip dates are not the payroll month");

  // Steps with no meaningful window must stay silent rather than guess.
  assert.equal(stepWindowLabel("p2_additions", july), null);
  assert.equal(stepWindowLabel("p2_manual_deductions", july), null);
  assert.equal(stepWindowLabel("p1_holds", july), null);

  // ---- the three steps must actually declare a breakdown -------------------
  // A missing detailColumns silently degrades to the old total-only view with
  // no error anywhere, which is exactly how the "Trips" context column sat
  // blank from 2026-07-20 until this change.
  for (const stepKey of ["p2_expenses", "p2_vacation", "p2_crm"] as const) {
    const definition = STEP_DEFINITIONS[stepKey];
    assert.ok((definition.detailColumns?.length ?? 0) > 0, `${stepKey} must declare detail columns`);
    assert.ok(definition.detailNoun, `${stepKey} must name its line noun so the expander reads "3 trips", not "3 lines"`);
    const keys = (definition.detailColumns ?? []).map((column) => column.key);
    assert.equal(new Set(keys).size, keys.length, `${stepKey} detail column keys must be unique — a duplicate silently hides a column`);
  }

  // The expense step's own "Trips" context column must stay declared: it is the
  // collapsed-row summary of the breakdown, and it rendered blank for a fortnight.
  const expenseContextKeys = STEP_DEFINITIONS.p2_expenses.contextColumns.map((column) => column.key);
  assert.ok(expenseContextKeys.includes("Trips"), "p2_expenses must keep its Trips count column");
  assert.ok(expenseContextKeys.includes("Trip Dates"), "p2_expenses must summarise the trip date span on the collapsed row");

  // Plural forms must be declared wherever adding "s" is wrong — this shipped to
  // the owner reading "3 leave entrys".
  assert.equal(STEP_DEFINITIONS.p2_vacation.detailNounPlural, "leave entries");

  // ---- Health Day is WORK, not leave (owner ruling 2026-08-01) --------------
  // "health day is a normal working day its an activity they do for patients in
  // the dr clinic." Mapping -15 to AV made it read as vacation: it consumed the
  // annual balance and, once that ran out, was deducted from salary — 22 days
  // across 11 employees in July 2026 alone. If this ever flips back to "AV",
  // every health day silently starts costing people leave again.
  assert.equal(
    leaverVisitTypeStatus(-15),
    "CP",
    "Health Day (-15) is working time — mapping it to AV charges leave for a day the rep worked",
  );
  assert.equal(leaverVisitTypeStatus(-4), "AV", "Annual Vacation (-4) is the only genuine leave type");
  for (const workingType of [-1, -2, -8, -9, -11, -12]) {
    assert.equal(leaverVisitTypeStatus(workingType), "CP", `visit type ${workingType} is a worked day`);
  }
}
