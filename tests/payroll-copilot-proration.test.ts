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
  // component at the same day share ------------------------------------------
  //
  // CHANGED 2026-08-29 on the owner's instruction ("in the resignations, prorate
  // the full net salary, not the base"). This branch used to pay ECOL and Fuel
  // as a flat 0, so these two assertions are the record of what he replaced: a
  // leaver on the 20th took 18/30 of base and nothing else. Restoring the zeros
  // would cut an affected leaver's pay, silently, so both figures are asserted
  // as exact values rather than "greater than zero".
  //
  // CHANGED AGAIN 2026-09-11, and this block used to assert the opposite. It ran with
  // `  // That subtraction charged the same approved leave TWICE: the Deductions module raises an
  // unpaid-vacation candidate from the very same `v2_vacation_requests` rows, and payroll charges
  // it on the Unpaid Vacation tab. The days came off the pay and the money came off again.
  //
  // The owner's ruling was to unify on the figure a human actually edits: "we must unify... what
  // really wins, admin edit outputs". The deduction is reviewable and correctable; the subtraction
  // here was invisible, and it also moved the Days Worked figure the admin is asked to correct by
  // hand. Two of this function's four callers — the Ready sheet and the resignations service — never
  // subtracted anyway, so the same leaver's days differed by which surface asked. Now all four agree.
  //
  // Days worked is therefore the calendar count to the last working day, full stop.
  const before25 = computeResignationSettlement({
    baseSalary: 30000,
    extraCostOfLiving: 1000,
    fuelAllowance: 500,
    lastWorkingDate: "2026-06-20",
    isResignation: true, // every case in this file is a genuine resignation
    period: JUNE,
    otherAdditions: 0,
    otherDeductions: 0,
  });
  assert.ok(before25);
  assert.equal(before25.branch, "on_or_before_25");
  assert.equal(
    before25.daysWorked,
    20,
    "days worked is the calendar count to the last working day — approved unpaid leave is charged " +
      "ONCE, by the deduction the admin reviews, not a second time by shortening the days here",
  );
  assert.equal(before25.baseForMonth, 20000); // 1000/day * 20
  assert.equal(before25.ecolPaid, 666.67, "ECOL prorates with the base — it is no longer withheld"); // 1000 * 20/30
  assert.equal(before25.fuelPaid, 333.33, "Fuel prorates with the base — it is no longer withheld"); // 500 * 20/30
  assert.equal(before25.netForMonth, 21000); // = 31,500 net * 20/30
  assert.equal(before25.total, 21000);

  // exact boundary: day 25 itself takes the "on or before" branch
  const boundary25 = computeResignationSettlement({
    baseSalary: 30000,
    extraCostOfLiving: 1000,
    fuelAllowance: 500,
    lastWorkingDate: "2026-06-25",
    isResignation: true, // every case in this file is a genuine resignation
    period: JUNE,
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
    isResignation: true, // every case in this file is a genuine resignation
    period: JUNE,
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
    isResignation: true, // every case in this file is a genuine resignation
    period: JUNE,
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

  // total below zero (the leaver owes money) -> nothing is paid in either part; never a negative
  // First Part (audit 2026-10-23, S-PAY-01: this returned { firstPart: -800, secondPart: 0 }).
  const owesMoney = applyResignationPartsSplit({ totalPayable: -800, basicSalary: 21000 });
  assert.deepEqual(owesMoney, { firstPart: 0, secondPart: 0 });

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
    resignation: { lastWorkingDate: "2026-06-20", isResignation: true },
  });
  assert.ok(resignRow);
  // OWNER RULE 2026-09-04, and the reason these four numbers changed: the salary
  // COLUMNS now show the full monthly contract on every row, and the Working Days
  // column is what explains a partial month. They used to show the settlement
  // (18000 / 600 / 300 / 18900) — the same figures the money is still built from,
  // which is asserted immediately below and did NOT move.
  assert.equal(resignRow.baseSalary, 30000, "the row shows the FULL contract base, not the settlement");
  assert.equal(resignRow.extraCostOfLiving, 1000, "the row shows the FULL contract ECOL");
  assert.equal(resignRow.fuelAllowance, 500, "the row shows the FULL contract Fuel");
  assert.equal(resignRow.netSalary, 31500, "the row shows a full month's net: 30000 + 1000 + 500");
  // 20 days to the last working day. It read 18 until 2026-09-11 — the same 20 less 2 approved
  // unpaid days — until that subtraction was removed because it charged the same approved leave
  // twice: the Deductions module raises an unpaid-vacation candidate from the very same requests
  // and payroll charges it on the Unpaid Vacation tab. Unified on the figure the admin edits.
  assert.equal(resignRow.workingDays, 20, "Working Days is what makes the full salary above readable");
  assert.equal(resignRow.calendarDays, 30, "June");
  assert.equal(resignRow.medicalInsurance, 300, "F: medical insurance still applies in full on a resignation row");
  // THE MONEY. This is the assertion that proves the display change above is only a display
  // change: payable is still built from the SETTLEMENT net, never from the 31,500 shown in the Net
  // Salary column. If showing the full salary ever started paying the full salary, these three
  // lines are what goes red.
  //
  // The settlement net moved from 18,900 to 21,000 on 2026-09-11: it is now 20/30 of 31,500 rather
  // than 18/30, because the two approved unpaid days are no longer subtracted here. They are
  // charged once, by the unpaid-vacation deduction the admin reviews, instead of twice.
  //
  // total payable = 21000 - 300 medical insurance = 20700; basic anchor = 30000*0.7 = 21000
  // 20700 < 21000 -> Part 1 absorbs everything, paid once
  assert.equal(resignRow.firstPart, 20700);
  assert.equal(resignRow.secondPart, 0);
  assert.equal(resignRow.monthSalary, 20700);

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
    resignation: { lastWorkingDate: "2026-06-20", isResignation: true },
    approvedExpenses: 800,
  });
  assert.ok(resignWithExpense);
  assert.equal(resignWithExpense.expenses, 800, "the approved expense shows on the leaver's row");
  // total payable = 21000 net + 800 expense - 300 medical = 21500; basic anchor 21000, so the
  // 500 above it lands in Part 2. The net moved from 18,900 on 2026-09-11 — see the block above.
  assert.equal(resignWithExpense.monthSalary, 21500, "leaver's expense is actually PAID, not dropped from the settlement");
  assert.equal(resignWithExpense.firstPart, 21000);
  assert.equal(resignWithExpense.secondPart, 500);

  // --- D full integration: resignation, after_25 branch, one_part mode -------
  const resignOnePart = buildRowForEmployee({
    employee: testEmployee({ medicalInsurance: 300 }),
    source: testSource({ paymentMode: "one_part" }),
    recurring: [],
    adjustments: [],
    period: JUNE,
    index: 1,
    resignation: { lastWorkingDate: "2026-06-28", isResignation: true },
  });
  assert.ok(resignOnePart);
  assert.equal(resignOnePart.baseSalary, 30000);
  assert.equal(resignOnePart.extraCostOfLiving, 1000);
  assert.equal(resignOnePart.fuelAllowance, 500);
  // Paid a full month under Rule 1, but he was here 28 days and the column says
  // so. Reporting 30 here would contradict the Ready sheet for the same person.
  assert.equal(resignOnePart.workingDays, 28, "the count stays date-derived even when the pay is waived up");
  assert.equal(resignOnePart.calendarDays, 30);
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
  // Full contract on the row (owner rule 2026-09-04). These were 12000 / 387.1 /
  // 193.55 / 12580.65 — the settlement figures, which the money below still uses.
  assert.equal(joinerRow.baseSalary, 31000, "the row shows the FULL contract base");
  assert.equal(joinerRow.extraCostOfLiving, 1000, "the row shows the FULL contract ECOL, not 12/31 of it");
  assert.equal(joinerRow.fuelAllowance, 500, "the row shows the FULL contract Fuel");
  assert.equal(joinerRow.netSalary, 32500, "the row shows a full month's net");
  assert.equal(joinerRow.workingDays, 12, "hired on the 20th of a 31-day month");
  assert.equal(joinerRow.calendarDays, 31);
  assert.equal(joinerRow.medicalInsurance, 300, "F: medical insurance still applies in full on a joiner row");
  // THE MONEY, UNCHANGED — the joiner half of the same proof. Payable is the
  // SETTLEMENT net (32,500 x 12/31 = 12,580.65) less 300 medical insurance.
  assert.equal(joinerRow.monthSalary, 12280.65, "a joiner is still PAID for the days worked, not the full contract");
  // And the two-part split still anchors on the PRORATED base: 12,000 x 70% =
  // 8,400, NOT 31,000 x 70% = 21,700. Were the split reading the full contract
  // now shown in the Base Salary column, Part 1 would swallow the whole 12,280.65
  // and Part 2 would be nil — so this pair is the sharpest test in the file of
  // whether the display change leaked into the payment.
  assert.equal(joinerRow.firstPart, 8400, "Part 1 is capped at 70% of the PRORATED base, not of the displayed contract");
  assert.equal(joinerRow.secondPart, 3880.65);
  assert.equal(
    joinerRow.firstPart + joinerRow.secondPart,
    joinerRow.monthSalary,
    "the two parts must still add up to what is paid",
  );

  // A DELIBERATE consequence of the owner's 2026-09-04 choice to show the
  // allowances at full contract value too: Net + Additions - Deductions no longer
  // equals Month Salary on a partial-month row (32,500 + 1,500 - 300 = 33,700 vs
  // 12,280.65 paid). Working Days is what reconciles them. This is pinned so the
  // gap reads as the decision it is, and nobody "repairs" the row back to the
  // settlement figures.
  assert.equal(joinerRow.totalAdditions, 1500, "additions carry the FULL ECOL + Fuel");
  assert.notEqual(
    joinerRow.netSalary + joinerRow.totalAdditions - joinerRow.totalDeductions,
    joinerRow.monthSalary,
  );

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
