import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveReadyLifecycleSettlement } from "../src/lib/payroll/ready-proration.ts";

/**
 * Proves the design claim from src/lib/resignations/service.ts's declineOfferAndOpenVacancy
 * doc comment: choosing employment_status "terminated" for the pay branch routes a
 * declined-offer employee through Ready Payroll's EXISTING, already-tested
 * leaver_non_resignation rule — base salary prorated to days worked, no cost-of-living or
 * fuel allowance, and (unlike a genuine resignation) no full-pay-after-25th waiver — rather
 * than asserting the claim in prose. No new proration math is introduced by this feature.
 */
export function runDeclineOfferPayrollRoutingTests() {
  const baseSalary = 9000;
  const extraCostOfLiving = 500;
  const fuelAllowance = 300;

  // Last day 15th (on/before the 25th).
  const midMonth = resolveReadyLifecycleSettlement({
    baseSalary,
    extraCostOfLiving,
    fuelAllowance,
    hireDate: null,
    isResignation: false,
    lastWorkingDate: "2026-09-15",
    month: 9,
    year: 2026,
  });
  assert.equal(midMonth.branch, "leaver_non_resignation", "a terminated declined-offer row must land in leaver_non_resignation");
  assert.equal(midMonth.extraCostOfLiving, 0, "cost of living must be withheld for the pay branch, not prorated");
  assert.equal(midMonth.fuelAllowance, 0, "fuel allowance must be withheld for the pay branch, not prorated");
  assert.equal(midMonth.workingDays, 15, "days worked must count from the 1st through the last working day");
  assert.ok(midMonth.prorationDeduction > 0, "base pay must be reduced for the unworked remainder of the month");

  // Last day 28th (after the 25th) — must NOT receive the resignation full-pay waiver,
  // since this is explicitly not a resignation.
  const afterTwentyFifth = resolveReadyLifecycleSettlement({
    baseSalary,
    extraCostOfLiving,
    fuelAllowance,
    hireDate: null,
    isResignation: false,
    lastWorkingDate: "2026-09-28",
    month: 9,
    year: 2026,
  });
  assert.equal(
    afterTwentyFifth.branch,
    "leaver_non_resignation",
    "the after-25th resignation waiver must not apply to a non-resignation declined-offer row",
  );
  assert.equal(afterTwentyFifth.extraCostOfLiving, 0, "no allowance even when the last day falls after the 25th");
  assert.equal(afterTwentyFifth.fuelAllowance, 0, "no allowance even when the last day falls after the 25th");
  assert.equal(afterTwentyFifth.workingDays, 28, "days worked must still count only through the actual last day");

  // The no-pay branch's exclusion is a SEPARATE guarantee: "declined_offer" must never be
  // added to Ready Payroll's own terminal-status set, or the no-pay branch would silently
  // start getting paid. Source-regex, not behavioural — the whole point is this file must
  // require NO code change on a green run.
  const templateRoute = readFileSync("app/api/payroll/template/route.ts", "utf8");
  assert.match(
    templateRoute,
    /terminalPayrollStatuses = new Set\(\["resigned", "terminated", "inactive"\]\)/,
    "Ready Payroll's terminal status set must stay exactly as pinned by tests/ready-payroll-template-formulas.test.ts",
  );
  assert.doesNotMatch(
    templateRoute,
    /"declined_offer"/,
    "\"declined_offer\" must never be added to Ready Payroll's terminalPayrollStatuses — that is what keeps the no-pay branch's payroll footprint at zero",
  );
}
