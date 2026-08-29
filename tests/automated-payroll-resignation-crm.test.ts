import assert from "node:assert/strict";

import { computeResignationSettlement, dailyRate } from "../src/lib/payroll/copilot/proration.ts";
import { resignationCrmDeduction } from "../src/lib/automated-payroll/recommend.ts";

/**
 * Guards the Resignations CRM tab's deduction rate.
 *
 * TWO owner rules stack here, and the second is what this file now exists to
 * hold:
 *
 *  1. 2026-07-26 — "unify the calculation formula, both must be based on month
 *     days." The divisor is the month's ACTUAL calendar days, never the fixed
 *     /30 every other manual-deduction tab uses. The bug that produced the rule:
 *     the shared CRM tab capped Working+Non-Working at the WHOLE MONTH, so a
 *     leaver who worked 9 days of a 31-day month could show 22 "non-working"
 *     days — days AFTER he had already left — and be deducted for them
 *     (verified against a real July 2026 leaver, B-111: base 14,000, resigned
 *     9 July, would have been charged 10,266.67 for 22 days he was not employed).
 *
 *  2. 2026-08-30 — "in the CRM, it must prorate the net salary." The amount
 *     divided is the leaver's monthly NET (Base + Extra Cost of Living + Fuel),
 *     not the Base. Rule 1 only holds if BOTH sides of the unification move
 *     together, and on 2026-08-29 one of them did: the settlement began
 *     prorating the whole net while this deduction still charged off the base,
 *     so a no-activity day cost strictly LESS than the day of pay it cancels.
 *     "Unified" had quietly stopped being true a day before the owner noticed.
 *
 * The discrimination assertions matter more than the equalities: passing the
 * base where the net is due still returns a plausible figure, so a test that
 * only checked "some sensible number" would have gone on passing straight
 * through the regression this file exists to catch.
 */

const NET = 16500; // base 14,000 + extra cost of living 2,000 + fuel 500
const BASE = 14000;

export async function runAutomatedPayrollResignationCrmTests() {
  // ---- the divisor must be ACTUAL calendar days, not /30 -------------------
  // July 2026 has 31 days: 16,500/31 × 2 = 1,064.52 (not 16,500/30 × 2 = 1,100).
  assert.equal(resignationCrmDeduction(NET, 2, { month: 7, year: 2026 }), 1064.52);
  assert.notEqual(
    resignationCrmDeduction(NET, 2, { month: 7, year: 2026 }),
    1100,
    "must NOT use the fixed /30 divisor every other deduction tab uses",
  );

  // June 2026 has 30 days — the same call must give a DIFFERENT number for a
  // 30-day month, proving the divisor genuinely varies by month rather than
  // being hardcoded to 31.
  assert.equal(resignationCrmDeduction(NET, 2, { month: 6, year: 2026 }), 1100);

  // February 2026 (not a leap year) has 28 days.
  assert.equal(resignationCrmDeduction(28000, 1, { month: 2, year: 2026 }), 1000);

  // ---- edge cases --------------------------------------------------------
  assert.equal(resignationCrmDeduction(NET, 0, { month: 7, year: 2026 }), 0, "zero non-working days -> zero deduction");
  assert.equal(resignationCrmDeduction(0, 5, { month: 7, year: 2026 }), 0, "no salary figure -> zero, never NaN/negative");
  assert.equal(resignationCrmDeduction(NET, -1, { month: 7, year: 2026 }), 0, "negative days must never produce a negative deduction");

  // ---- "unified formula" proof, against the settlement as it ACTUALLY pays --
  // The settlement is COMPUTED here rather than assumed, so if the proration
  // rule moves again this fails loudly instead of drifting apart in silence.
  const period = { month: 7, year: 2026 };
  const settlement = computeResignationSettlement({
    baseSalary: BASE,
    extraCostOfLiving: 2000,
    fuelAllowance: 500,
    lastWorkingDate: "2026-07-09",
    period,
    unpaidDaysInSpan: 0,
    otherAdditions: 0,
    otherDeductions: 0,
  });
  assert.ok(settlement, "sanity: a 9 July last working date settles");
  assert.equal(settlement.daysWorked, 9);

  // The settlement rounds Base, Extra Cost of Living and Fuel SEPARATELY and adds
  // them, so a row's three visible parts always sum to the row's own total. The
  // same money priced at a single net day-rate can therefore land one cent away
  // (4,790.33 component-rounded vs 4,790.32 single-rate here). That gap is real
  // and it is BOUNDED AT A CENT — asserting the two are identical would only pass
  // by coincidence of the fixture, and would false-fail on the next leaver.
  assert.equal(settlement.netForMonth, 4790.33, "nine days of net, each component rounded");
  const singleRate = roundToCents(dailyRate(NET, period) * 9);
  assert.ok(
    withinACent(settlement.netForMonth, singleRate),
    `settlement ${settlement.netForMonth} must stay within a cent of the single-rate ${singleRate} — a wider gap means the two sides have parted company again`,
  );

  const settlementDayRate = settlement.netForMonth / settlement.daysWorked;
  assert.equal(
    resignationCrmDeduction(NET, 1, period),
    roundToCents(settlementDayRate),
    "one non-working day must cost EXACTLY one day of what the settlement pays",
  );

  // ---- THE 2026-08-30 REGRESSION GUARD ------------------------------------
  // Charging off the BASE is the pre-fix behaviour. It must not coincide with
  // charging off the NET, or the fixture above cannot detect a reversion.
  assert.notEqual(
    resignationCrmDeduction(BASE, 2, period),
    resignationCrmDeduction(NET, 2, period),
    "base and net must give different deductions — otherwise this file proves nothing",
  );
  assert.ok(
    resignationCrmDeduction(BASE, 2, period) < resignationCrmDeduction(NET, 2, period),
    "the old base rate charged LESS than a day of pay is worth — the exact under-deduction the owner's rule closes",
  );

  // ---- full worked example, end to end -------------------------------------
  // Net 16,500, last working day the 9th, 9 days worked, 2 no-activity days in
  // that span.
  const crmDeduction = resignationCrmDeduction(NET, 2, period);
  const julySalary = roundToCents(settlement.netForMonth - crmDeduction);
  assert.equal(crmDeduction, 1064.52);
  assert.equal(julySalary, 3725.81, "9 days paid at the net rate, less 2 days charged at the same rate");

  // Seven paid-and-worked days, priced two ways, must agree to the cent. That
  // interchangeability IS the unification — if it ever stops holding, the tab
  // has drifted from the settlement again.
  assert.ok(
    withinACent(julySalary, roundToCents(dailyRate(NET, period) * 7)),
    "9 days paid minus 2 days charged must equal 7 days at the one rate, to the cent",
  );
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Compared in whole cents, not as floats. `4790.33 - 4790.32` evaluates to
 * 0.010000000000218 in IEEE-754, so a literal `<= 0.01` rejects a one-cent gap
 * — which is precisely the gap this file means to permit.
 */
function withinACent(a: number, b: number): boolean {
  return Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= 1;
}
