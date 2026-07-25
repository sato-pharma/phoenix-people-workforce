import assert from "node:assert/strict";

import { dailyRate } from "../src/lib/payroll/copilot/proration.ts";
import { resignationCrmDeduction } from "../src/lib/automated-payroll/recommend.ts";

/**
 * Guards the Resignations CRM tab's deduction rate (owner rule 2026-07-26):
 * "unify the calculation formula — both must be based on month days." The
 * real bug this tab replaces: the shared CRM tab capped Working+Non-Working
 * at the WHOLE MONTH, so a leaver who worked only 9 days of a 31-day month
 * could show 22 "non-working" days — days AFTER he had already left — and be
 * deducted for them (verified against a real July 2026 leaver, B-111: base
 * 14,000, resigned 9 July, would have been charged 10,266.67 for 22 days he
 * was no longer employed). This tab's deduction must divide by the SAME rate
 * the resignation settlement itself uses (Base ÷ actual calendar days in the
 * month), not the fixed /30 every other manual-deduction tab uses.
 */

export async function runAutomatedPayrollResignationCrmTests() {
  // ---- the deduction rate must be Base ÷ ACTUAL calendar days, not /30 ------
  // July 2026 has 31 days. Owner's worked example: base 14,000, 2 non-working
  // days -> 14,000/31 × 2 = 903.23 (not 14,000/30 × 2 = 933.33).
  assert.equal(resignationCrmDeduction(14000, 2, { month: 7, year: 2026 }), 903.23);
  assert.notEqual(
    resignationCrmDeduction(14000, 2, { month: 7, year: 2026 }),
    933.33,
    "must NOT use the fixed /30 divisor every other deduction tab uses",
  );

  // June 2026 has 30 days — the same call must give a DIFFERENT number for a
  // 30-day month, proving the divisor genuinely varies by month rather than
  // being hardcoded to 31.
  assert.equal(resignationCrmDeduction(14000, 2, { month: 6, year: 2026 }), 933.33);

  // February 2026 (not a leap year) has 28 days.
  assert.equal(resignationCrmDeduction(28000, 1, { month: 2, year: 2026 }), 1000);

  // ---- edge cases --------------------------------------------------------
  assert.equal(resignationCrmDeduction(14000, 0, { month: 7, year: 2026 }), 0, "zero non-working days -> zero deduction");
  assert.equal(resignationCrmDeduction(0, 5, { month: 7, year: 2026 }), 0, "no base salary -> zero, never NaN/negative");
  assert.equal(resignationCrmDeduction(14000, -1, { month: 7, year: 2026 }), 0, "negative days must never produce a negative deduction");

  // ---- "unified formula" proof: the CRM deduction's implied per-day rate
  // must be IDENTICAL to the resignation settlement's own daily rate
  // (proration.ts's dailyRate — the exact function computeResignationSettlement
  // uses). This is the owner's literal instruction: "we have to unify the
  // calculation formula both must be based on month days." -------------------
  const period = { month: 7, year: 2026 };
  const settlementRate = dailyRate(14000, period);
  const crmOneDayRate = resignationCrmDeduction(14000, 1, period);
  assert.equal(settlementRate, 14000 / 31, "sanity: the canonical daily rate for base 14,000 in a 31-day month");
  assert.equal(
    crmOneDayRate,
    roundToCents(settlementRate),
    "one non-working day must cost EXACTLY one day of the resignation settlement's own daily rate",
  );

  // ---- full worked example from the owner, end to end -----------------------
  // Base 14,000, resigned day 10, 9 days worked, 2 no-activity days within that span.
  const rate = dailyRate(14000, period);
  const settlement = roundToCents(rate * 9);
  const crmDeduction = resignationCrmDeduction(14000, 2, period);
  const julySalary = roundToCents(settlement - crmDeduction);
  assert.equal(settlement, 4064.52);
  assert.equal(crmDeduction, 903.23);
  assert.equal(julySalary, 3161.29, "owner's worked example: 4,064.52 - 903.23 = 3,161.29");
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}
