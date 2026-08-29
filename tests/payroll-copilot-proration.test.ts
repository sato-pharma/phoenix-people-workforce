import assert from "node:assert/strict";

import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { buildRowForEmployee } from "../src/lib/payroll/copilot/assemble.ts";
import {
  applyResignationPartsSplit,
  calendarDaysInMonth,
  computeJoinerPay,
  computeResignationSettlement,
  dailyRate,
} from "../src/lib/payroll/copilot/proration.ts";
import type { CopilotPeriod } from "../src/lib/payroll/copilot/types.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";

// June 2026 = 30 days; July 2026 = 31 days — real calendar days, not a flat 30.
const JUNE: CopilotPeriod = { month: 6, year: 2026 };
const JULY: CopilotPeriod = { month: 7, year: 2026 };

function testEmployee(overrides: Partial<EmployeeDirectoryRow> = {}): EmployeeDirectoryRow {
  return {
    hrId: "B-PRORATE",
    fullName: "Proration Test",
    nameAr: null,
    jobTitle: "Medical Representative",
    lineName: "Line A",
    areaName: "Area 1",
    hireDate: "2020-01-01",
    employmentStatus: "active",
    payrollEligible: true,
    medicalInsurance: 0,
    ...overrides,
  } as unknown as EmployeeDirectoryRow;
}

function testSource(overrides: Partial<PayrollSalarySource> = {}): PayrollSalarySource {
  return {
    baseSalary: 30000,
    grossSalary: 30000,
    netSalary: 31500,
    socialInsurance: 0,
    employmentIncomeTax: 0,
    extraCostOfLiving: 1000,
    fuelAllowance: 500,
    paymentMode: "two_parts",
    ...overrides,
  };
}

export function runPayrollCopilotProrationTests() {
  // --- universal daily rate: Base only, real calendar days, never a flat 30 ---
  assert.equal(calendarDaysInMonth(JUNE), 30);
  assert.equal(calendarDaysInMonth(JULY), 31);
  assert.equal(dailyRate(30000, JUNE), 1000);
  assert.equal(dailyRate(31000, JULY), 1000);

  // --- resignation Rule 1: last working day <= 25th -> NET proration, every
  // component at the same day share, minus unpaid-leave days inside the span --
  //
  // CHANGED 2026-08-29 on the owner's instruction ("in the resignations, prorate
  // the full net salary, not the base"). This branch used to pay ECOL and Fuel
  // as a flat 0, so these two assertions are the record of what he replaced: a
  // leaver on the 20th took 18/30 of base and nothing else. Restoring the zeros
  // would cut an affected leaver's pay, silently, so both figures are asserted
  // as exact values rather than "greater than zero".
  const before25 = computeResignationSettlement({
    baseSalary: 30000,
    extraCostOfLiving: 1000,
    fuelAllowance: 500,
    lastWorkingDate: "2026-06-20",
    period: JUNE,
    unpaidDaysInSpan: 2,
    otherAdditions: 0,
    otherDeductions: 0,
  });
  assert.ok(before25);
  assert.equal(before25.branch, "on_or_before_25");
  assert.equal(before25.daysWorked, 18); // 20 - 2 unpaid days
  assert.equal(before25.baseForMonth, 18000); // 1000/day * 18
  assert.equal(before25.ecolPaid, 600, "ECOL prorates with the base now — it is no longer withheld"); // 1000 * 18/30
  assert.equal(before25.fuelPaid, 300, "Fuel prorates with the base now — it is no longer withheld"); // 500 * 18/30
  assert.equal(before25.netForMonth, 18900); // = 31,500 net * 18/30
  assert.equal(before25.total, 18900);

  // exact boundary: day 25 itself takes the "on or before" branch
  const boundary25 = computeResignationSettlement({
    baseSalary: 30000,
    extraCostOfLiving: 1000,
    fuelAllowance: 500,
    lastWorkingDate: "2026-06-25",
    period: JUNE,
    unpaidDaysInSpan: 0,
    otherAdditions: 0,
    otherDeductions: 0,
  });
  assert.ok(boundary25);
  assert.equal(boundary25.branch, "on_or_before_25");
  assert.equal(boundary25.baseForMonth, 25000);
  assert.equal(boundary25.ecolPaid, 833.33); // 1000 * 25/30
  assert.equal(boundary25.fuelPaid, 416.67); // 500 * 25/30
  assert.equal(boundary25.netForMonth, 26250); // = 31,500 net * 25/30

  // The two branches must stay far apart at the boundary — one day later is a
  // FULL month, not a 26/30 one. That step is the rule, not a rounding edge.
  const boundary26 = computeResignationSettlement({
    baseSalary: 30000,
    extraCostOfLiving: 1000,
    fuelAllowance: 500,
    lastWorkingDate: "2026-06-26",
    period: JUNE,
    unpaidDaysInSpan: 0,
    otherAdditions: 0,
    otherDeductions: 0,
  });
  assert.ok(boundary26);
  assert.equal(boundary26.branch, "after_25", "the 26th crosses into the full-pay branch");
  assert.equal(
    boundary26.netForMonth,
    31500,
    "one day past the boundary pays the WHOLE net — prorating the net must not have softened the >25th waiver into a 26/30 share",
  );

  // --- resignation Rule 1: last working day > 25th -> Base/ECOL/Fuel in FULL,
  // no proration at all, +additions -deductions on top -----------------------
  const after25 = computeResignationSettlement({
    baseSalary: 30000,
    extraCostOfLiving: 1000,
    fuelAllowance: 500,
    lastWorkingDate: "2026-06-28",
    period: JUNE,
    unpaidDaysInSpan: 0,
    otherAdditions: 2000,
    otherDeductions: 500,
  });
  assert.ok(after25);
  assert.equal(after25.branch, "after_25");
  assert.equal(after25.baseForMonth, 30000);
  assert.equal(after25.ecolPaid, 1000);
  assert.equal(after25.fuelPaid, 500);
  assert.equal(after25.netForMonth, 31500);
  assert.equal(after25.total, 33000); // 31500 + 2000 - 500

  // --- resignation Rule 2: Part1/Part2 clawback (two-part payment mode) ------
  // total >= basic salary (30000*0.7=21000) -> Part1 unchanged, Part2 absorbs the rest
  const aboveBasic = applyResignationPartsSplit({ totalPayable: 25000, basicSalary: 21000 });
  assert.deepEqual(aboveBasic, { firstPart: 21000, secondPart: 4000 });

  // total < basic salary -> Part1 absorbs everything, paid once, Part2 = 0
  const belowBasic = applyResignationPartsSplit({ totalPayable: 15000, basicSalary: 21000 });
  assert.deepEqual(belowBasic, { firstPart: 15000, secondPart: 0 });

  // --- joiner: EVERY component prorates by the same day share (owner
  // instruction 2026-08-29 — "you divide the net salary"). The hire date itself
  // still counts as a paid day. ------------------------------------------------
  const joinerEarly = computeJoinerPay({
    baseSalary: 31000,
    extraCostOfLiving: 1000,
    fuelAllowance: 500,
    hireDate: "2026-07-10",
    period: JULY,
  });
  assert.ok(joinerEarly);
  assert.equal(joinerEarly.daysWorked, 22); // 31 - 10 + 1, hire date inclusive
  assert.equal(joinerEarly.baseForMonth, 22000); // 1000/day * 22
  assert.equal(joinerEarly.ecolPaid, 709.68); // 1000 * 22/31 — no longer paid whole
  assert.equal(joinerEarly.fuelPaid, 354.84); // 500 * 22/31
  assert.equal(joinerEarly.netForMonth, 23064.52); // = 32,500 net * 22/31

  // hired after the 15th: the SAME rule, with no halving cliff
  const joinerLate = computeJoinerPay({
    baseSalary: 31000,
    extraCostOfLiving: 1000,
    fuelAllowance: 500,
    hireDate: "2026-07-20",
    period: JULY,
  });
  assert.ok(joinerLate);
  assert.equal(joinerLate.daysWorked, 12); // 31 - 20 + 1
  assert.equal(joinerLate.baseForMonth, 12000);
  assert.equal(joinerLate.ecolPaid, 387.1); // 1000 * 12/31, NOT the retired 500 half
  assert.equal(joinerLate.fuelPaid, 193.55); // 500 * 12/31, NOT the retired 250
  assert.equal(joinerLate.netForMonth, 12580.65); // = 32,500 net * 12/31

  // The >15th halving is GONE, and this is what proves it: the 15th and the 16th
  // must now differ by exactly ONE day of net. Under the retired rule the 16th
  // lost half of BOTH allowances at a stroke, making this gap 1,750.00 instead of
  // 1,048.39. Reintroduce the halving and this assertion fails.
  const netDayRate = 32500 / 31;
  const on15th = computeJoinerPay({
    baseSalary: 31000,
    extraCostOfLiving: 1000,
    fuelAllowance: 500,
    hireDate: "2026-07-15",
    period: JULY,
  });
  const on16th = computeJoinerPay({
    baseSalary: 31000,
    extraCostOfLiving: 1000,
    fuelAllowance: 500,
    hireDate: "2026-07-16",
    period: JULY,
  });
  assert.ok(on15th);
  assert.ok(on16th);
  assert.equal(on15th.daysWorked, 17); // 31 - 15 + 1
  assert.equal(on16th.daysWorked, 16);
  assert.equal(
    Math.round((on15th.netForMonth - on16th.netForMonth) * 100) / 100,
    Math.round(netDayRate * 100) / 100,
    "crossing the 15th must cost exactly one day of NET — the retired rule dropped half of both allowances here",
  );

  // ===========================================================================
  // Integration through buildRowForEmployee
  // ===========================================================================

  // --- D full integration: resignation, on_or_before_25 branch, two_parts ----
  const resignRow = buildRowForEmployee({
    employee: testEmployee({ medicalInsurance: 300 }),
    source: testSource(),
    recurring: [],
    adjustments: [],
    period: JUNE,
    index: 1,
    resignation: { lastWorkingDate: "2026-06-20", unpaidDaysInSpan: 2 },
  });
  assert.ok(resignRow);
  assert.equal(resignRow.baseSalary, 18000, "row.baseSalary reflects the prorated settlement for this month");
  assert.equal(resignRow.extraCostOfLiving, 600, "the row carries the PRORATED ECOL, not a withheld zero");
  assert.equal(resignRow.fuelAllowance, 300, "the row carries the PRORATED Fuel, not a withheld zero");
  assert.equal(resignRow.netSalary, 18900);
  assert.equal(resignRow.medicalInsurance, 300, "F: medical insurance still applies in full on a resignation row");
  // total payable = 18900 - 300 medical insurance = 18600; basic anchor = 30000*0.7=21000
  // 18600 < 21000 -> Part1 absorbs everything, paid once
  assert.equal(resignRow.firstPart, 18600);
  assert.equal(resignRow.secondPart, 0);
  assert.equal(resignRow.monthSalary, 18600);

  // --- D': leaver with an approved expense — the reimbursement must be PAID in
  // the settlement, not just displayed. Regression for the bug where
  // settlementAdditions excluded expenses, so a departing employee lost any
  // approved outstation expense from their final pay. Same row as above (leaver
  // 2026-06-20, net 18900, medical 300) plus an 800 approved expense.
  const resignWithExpense = buildRowForEmployee({
    employee: testEmployee({ medicalInsurance: 300 }),
    source: testSource(),
    recurring: [],
    adjustments: [],
    period: JUNE,
    index: 1,
    resignation: { lastWorkingDate: "2026-06-20", unpaidDaysInSpan: 2 },
    approvedExpenses: 800,
  });
  assert.ok(resignWithExpense);
  assert.equal(resignWithExpense.expenses, 800, "the approved expense shows on the leaver's row");
  // total payable = 18900 net + 800 expense - 300 medical = 19400; basic anchor 21000 -> Part1 absorbs all
  assert.equal(resignWithExpense.monthSalary, 19400, "leaver's expense is actually PAID, not dropped from the settlement");
  assert.equal(resignWithExpense.firstPart, 19400);
  assert.equal(resignWithExpense.secondPart, 0);

  // --- D full integration: resignation, after_25 branch, one_part mode -------
  const resignOnePart = buildRowForEmployee({
    employee: testEmployee({ medicalInsurance: 300 }),
    source: testSource({ paymentMode: "one_part" }),
    recurring: [],
    adjustments: [],
    period: JUNE,
    index: 1,
    resignation: { lastWorkingDate: "2026-06-28", unpaidDaysInSpan: 0 },
  });
  assert.ok(resignOnePart);
  assert.equal(resignOnePart.baseSalary, 30000);
  assert.equal(resignOnePart.extraCostOfLiving, 1000);
  assert.equal(resignOnePart.fuelAllowance, 500);
  // total = 31500 net - 300 medical insurance = 31200; one-part -> paid once, Part2 = 0
  assert.equal(resignOnePart.firstPart, 31200);
  assert.equal(resignOnePart.secondPart, 0);
  assert.equal(resignOnePart.monthSalary, 31200);

  // --- E full integration: joiner mid-month continues through the NORMAL
  // two_parts split (not the resignation clawback) ----------------------------
  const joinerRow = buildRowForEmployee({
    employee: testEmployee({ hireDate: "2026-07-20", medicalInsurance: 300 }),
    source: testSource({ baseSalary: 31000, grossSalary: 31000, netSalary: 32500 }),
    recurring: [],
    adjustments: [],
    period: JULY,
    index: 1,
  });
  assert.ok(joinerRow);
  assert.equal(joinerRow.baseSalary, 12000); // prorated for 12 days
  assert.equal(joinerRow.extraCostOfLiving, 387.1); // 1000 * 12/31 — prorated, not halved
  assert.equal(joinerRow.fuelAllowance, 193.55); // 500 * 12/31
  assert.equal(joinerRow.netSalary, 12580.65); // = 32,500 net * 12/31
  assert.equal(joinerRow.medicalInsurance, 300, "F: medical insurance still applies in full on a joiner row");

  // --- C: unpaid leave (continuing employee) uses Base-only day-rate, ECOL/Fuel
  // stay untouched -------------------------------------------------------------
  const unpaidLeaveRow = buildRowForEmployee({
    employee: testEmployee(),
    source: testSource(),
    recurring: [],
    adjustments: [{
      id: "adj-1",
      runId: "run-1",
      employeeHrId: "B-PRORATE",
      kind: "prorate",
      amount: null,
      field: null,
      workedDays: 25, // worked 25 of 30 June days -> 5 unpaid
      reason: "unpaid leave",
      recurringId: null,
      source: "chat",
      createdBy: null,
      createdAt: new Date(0).toISOString(),
    }],
    period: JUNE,
    index: 1,
  });
  assert.ok(unpaidLeaveRow);
  assert.equal(unpaidLeaveRow.unpaidVacations, 5000); // 1000/day * 5 unpaid days, Base-only
  assert.equal(unpaidLeaveRow.extraCostOfLiving, 1000, "ECOL stays full for unpaid leave");
  assert.equal(unpaidLeaveRow.fuelAllowance, 500, "Fuel stays full for unpaid leave");

  // --- normal month: Base/Basic/Net never move (no resignation, no joiner) ---
  const normalRow = buildRowForEmployee({
    employee: testEmployee(),
    source: testSource(),
    recurring: [],
    adjustments: [],
    period: JUNE,
    index: 1,
  });
  assert.ok(normalRow);
  assert.equal(normalRow.baseSalary, 30000);
  assert.equal(normalRow.netSalary, 31500);
}
