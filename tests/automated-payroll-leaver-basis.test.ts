import assert from "node:assert/strict";

import {
  leaverDayDeduction,
  prorateLeaverNet,
  resolveLeaverBasis,
} from "../src/lib/automated-payroll/leaver-basis.ts";
import type { DraftRow, PayrollPeriod } from "../src/lib/automated-payroll/types.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";

/**
 * THE ONE LEAVER RULE — days worked and the day rate, resolved once.
 *
 * The owner's report, 2026-08-30: *"I choose and select and confirm working days
 * of resignations in the resignations step in the automated payroll part one.
 * Then I go to the CRM deductions of the resignations. I found that the working
 * days I set in the resignations is different than this."* Plus: *"in the CRM,
 * it must prorate the net salary"* and *"the rule must be synced everywhere in
 * the module. I don't have to make the rule every tab."*
 *
 * Measured on the live August 2026 run before the fix, 7 of the 20 settled
 * leavers disagreed between the two tabs. The worst is reproduced verbatim below
 * (B-34: 12 confirmed, 28 shown) because a rounded example would not have caught
 * it — the calendar count and the confirmed count coincide for most leavers, and
 * that coincidence is exactly why this survived so long.
 *
 * Every assertion here is about AGREEMENT between two call sites. A test that
 * only checked one tab's arithmetic would pass in the broken state.
 */

const PERIOD: PayrollPeriod = { month: 8, year: 2026 }; // 31 days

function source(over: Partial<PayrollSalarySource> = {}): PayrollSalarySource {
  return {
    baseSalary: 15000,
    basicSalary: null,
    employmentIncomeTax: null,
    extraCostOfLiving: 2000,
    fuelAllowance: 500,
    grossSalary: null,
    hasAnyRawCompensationFigure: true,
    netSalary: 17500,
    paymentMode: "two_parts",
    socialInsurance: null,
    ...over,
  } as PayrollSalarySource;
}

function draft(over: Partial<DraftRow>): DraftRow {
  return { daysWorked: null, resignationCrmDays: null, ...over } as DraftRow;
}

export async function runAutomatedPayrollLeaverBasisTests() {
  // ---- with nothing confirmed, the basis is the settlement's own count ------
  const fresh = resolveLeaverBasis({
    source: source(),
    lastWorkingDate: "2026-08-28",
    period: PERIOD,
    unpaidDaysInSpan: 0,
    draft: undefined,
  });
  assert.ok(fresh, "sanity: a parseable last working date resolves");
  assert.equal(fresh.monthDays, 31, "August has 31 days");
  assert.equal(fresh.daysWorked, 28, "no confirmation yet -> the calendar count");
  assert.equal(fresh.recommendedDaysWorked, 28);
  assert.equal(fresh.confirmed, false);

  // ---- THE REPORTED BUG: a confirmed figure must WIN, everywhere ------------
  // B-34 Sherouk Wael, live August run: last working date the 28th, but HR
  // confirmed 12 days worked. Before the fix the Resignations tab showed 12 and
  // the Resignations CRM tab showed 28.
  const confirmed = resolveLeaverBasis({
    source: source(),
    lastWorkingDate: "2026-08-28",
    period: PERIOD,
    unpaidDaysInSpan: 0,
    draft: draft({ daysWorked: 12 }),
  });
  assert.ok(confirmed);
  assert.equal(confirmed.daysWorked, 12, "the CONFIRMED figure is what every tab must read");
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.recommendedDaysWorked, 28, "the system's own count is still reported, as the recommendation");
  assert.notEqual(
    confirmed.daysWorked,
    confirmed.recommendedDaysWorked,
    "fixture must actually discriminate — if these coincided the test could not fail",
  );

  // The CRM tab's cap is `daysWorked`. That it now reads 12 rather than 28 is
  // the whole safety property: a man who worked 12 days cannot be marked
  // non-working for 28.
  assert.ok(
    confirmed.daysWorked < 28,
    "the non-working cap must follow the confirmed days, not the last working date",
  );

  // ---- a fractional confirmation survives intact ---------------------------
  // B-179 Ashraf Maged, live August run: confirmed at half a day.
  const halfDay = resolveLeaverBasis({
    source: source({ baseSalary: 15500, netSalary: 18000 }),
    lastWorkingDate: "2026-08-09",
    period: PERIOD,
    unpaidDaysInSpan: 0,
    draft: draft({ daysWorked: 0.5 }),
  });
  assert.ok(halfDay);
  assert.equal(halfDay.daysWorked, 0.5, "half a day must not be rounded away");

  // ---- an out-of-range stored value is DISCARDED, not clamped ---------------
  // A count above the month's length can only be the pre-2026-07-26 whole-month
  // bug. Re-recommending self-heals it; clamping would freeze a wrong number at
  // the boundary and make it look deliberate.
  const stale = resolveLeaverBasis({
    source: source(),
    lastWorkingDate: "2026-08-09",
    period: PERIOD,
    unpaidDaysInSpan: 0,
    draft: draft({ daysWorked: 44 }),
  });
  assert.ok(stale);
  assert.equal(stale.daysWorked, 9, "a stored 44 in a 31-day month is discarded, not clamped to 31");
  assert.equal(stale.confirmed, false);

  // ---- the rate is NET ÷ actual month days, and nothing else ----------------
  assert.equal(confirmed.netSalary, 17500, "net is base + extra cost of living + fuel");
  assert.equal(confirmed.dailyRate, 17500 / 31);
  assert.notEqual(
    confirmed.dailyRate,
    15000 / 31,
    "must not be the BASE rate — that is the 2026-08-30 regression",
  );
  assert.notEqual(confirmed.dailyRate, 17500 / 30, "must not be the /30 deduction rate");

  // ---- ONE RATE: a day paid and a day deducted are the same money -----------
  // This is the owner's "synced everywhere" made checkable. If the settlement
  // and the deduction ever diverge again, this line fails.
  // Pay is component-rounded (so a row's parts sum to its total) while a single
  // deduction is rounded once, so the two can sit a cent apart. A CENT is the
  // whole permitted gap — asserting exact identity would pass only by fixture
  // coincidence, and the property that actually matters is that a day is priced
  // the same on both sides.
  const paid = prorateLeaverNet(confirmed, 12);
  assert.ok(
    withinACent(paid.netForMonth, round(confirmed.dailyRate * 12)),
    `12 days of pay (${paid.netForMonth}) must be 12 days at the one rate, to the cent`,
  );
  assert.ok(
    withinACent(leaverDayDeduction(confirmed, 1), paid.netForMonth / 12),
    "one no-activity day must cost one day of the pay it cancels, to the cent",
  );
  assert.equal(
    leaverDayDeduction(confirmed, 12),
    round(confirmed.dailyRate * 12),
    "a full-span deduction is priced at the same rate the span is paid at",
  );

  // ---- correcting the days re-prorates ALL THREE components -----------------
  // Before 2026-08-30 only Base moved, so Extra Cost of Living and Fuel silently
  // kept the figures belonging to the UNCORRECTED count — which undid the
  // owner's 2026-08-29 "prorate the whole net" rule the moment anyone used the
  // editable field it was paired with.
  assert.equal(paid.baseForMonth, round((15000 / 31) * 12));
  assert.equal(paid.ecolPaid, round((2000 / 31) * 12));
  assert.equal(paid.fuelPaid, round((500 / 31) * 12));
  assert.equal(
    paid.netForMonth,
    round(paid.baseForMonth + paid.ecolPaid + paid.fuelPaid),
    "the three parts must add to the total every screen displays",
  );

  const uncorrected = prorateLeaverNet(confirmed, 28);
  assert.notEqual(paid.ecolPaid, uncorrected.ecolPaid, "cost of living must follow the day count");
  assert.notEqual(paid.fuelPaid, uncorrected.fuelPaid, "fuel must follow the day count");

  // ---- an employee with no salary figure prices at nothing, never at NaN ----
  const noSalary = resolveLeaverBasis({
    source: source({ baseSalary: null, extraCostOfLiving: 0, fuelAllowance: 0, netSalary: null }),
    lastWorkingDate: "2026-08-09",
    period: PERIOD,
    unpaidDaysInSpan: 0,
    draft: undefined,
  });
  assert.ok(noSalary);
  assert.equal(noSalary.dailyRate, 0);
  assert.equal(leaverDayDeduction(noSalary, 5), 0, "no salary -> zero, never NaN and never negative");
  assert.equal(prorateLeaverNet(noSalary, 5).netForMonth, 0);

  // ---- an unparseable last working date declines, it does not guess ---------
  assert.equal(
    resolveLeaverBasis({
      source: source(),
      lastWorkingDate: "not-a-date",
      period: PERIOD,
      unpaidDaysInSpan: 0,
      draft: undefined,
    }),
    null,
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Compared in whole cents, not as floats. `4790.33 - 4790.32` evaluates to
 * 0.010000000000218 in IEEE-754, so a literal `<= 0.01` rejects a one-cent gap
 * — which is precisely the gap these assertions mean to permit.
 */
function withinACent(a: number, b: number): boolean {
  return Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= 1;
}
