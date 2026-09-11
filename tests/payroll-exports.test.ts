import assert from "node:assert/strict";

import { buildBankFileRows, type EmployeeBankInfo } from "../src/lib/payroll/exports/bank-file.ts";
import { buildStatutorySummaryRows } from "../src/lib/payroll/exports/statutory-summary.ts";
import { DEFAULT_STATUTORY_CONFIG } from "../src/lib/payroll/statutory/config.ts";
import type { SalaryRecord } from "../src/lib/payroll/types.ts";

function makeRecord(overrides: Partial<SalaryRecord> = {}): SalaryRecord {
  return {
    area: "Area 1",
    batchId: "batch-1",
    baseSalary: 0,
    bonus: 0,
    calendarDays: 30,
    crm: 0,
    employeeCode: "",
    hrId: "B-1",
    employmentIncomeTax: 0,
    expenses: 0,
    extraCostOfLiving: 0,
    fingerPrint: 0,
    firstPart: 0,
    fuelAllowance: 0,
    fullName: "Test Employee",
    governmentalDeductions: 0,
    grossSalary: 0,
    hireDate: null,
    nameAr: null,
    id: "rec-1",
    incentive: 0,
    jobTitle: "Medical Representative",
    line: "Line A",
    loans: 0,
    medicalInsurance: 0,
    monthSalary: 0,
    netSalary: 0,
    otherAdditions: 0,
    otherDeductions: 0,
    overtime: 0,
    payrollComment: null,
    paymentMode: "two_parts",
    secondPart: 0,
    socialInsurance: 0,
    totalAdditions: 0,
    totalDeductions: 0,
    unpaidVacations: 0,
    workingDays: 30,
    ...overrides,
  };
}

export function runPayrollExportsTests() {
  // --- bank-transfer file ----------------------------------------------------
  const bankMap = new Map<string, EmployeeBankInfo>([
    ["b100", { bankName: "NBE", bankAccount: "EG123456", hasBankAccount: "yes" }],
  ]);
  const bankRows = buildBankFileRows(
    [
      makeRecord({ hrId: "B-100", fullName: "Ahmed", monthSalary: 5000 }),
      makeRecord({ hrId: "B-200", fullName: "Mona", monthSalary: 4200 }),
    ],
    bankMap,
  );
  assert.equal(bankRows.length, 2);
  assert.equal(bankRows[0].hrId, "B-100");
  assert.equal(bankRows[0].bankName, "NBE");
  assert.equal(bankRows[0].bankAccount, "EG123456");
  assert.equal(bankRows[0].amount, 5000);
  assert.equal(bankRows[0].missingBank, false);
  // B-200 has no bank record → flagged
  assert.equal(bankRows[1].missingBank, true);
  assert.equal(bankRows[1].amount, 4200);

  // --- statutory summary: the subject wage is READ, never reconstructed --------------------
  //
  // WHAT THIS REPLACES. The old assertions fed deductions that were exactly 11% of a round wage
  // (1837 = 11% of 16,700), so dividing the deduction by the rate gave the wage back and the test
  // went green. That is the one input shape on which the defect is invisible — and production
  // carries the opposite shape on every single record. This test now uses production's shape.
  const wages = new Map<string, number | null>([
    ["b100", 16700],
    ["b101", 7700],
    ["b102", 40000], // above the ceiling — must clamp, never file at 40,000
    // b103 is deliberately absent: nobody has entered a wage for them.
  ]);
  const { rows, totals } = buildStatutorySummaryRows(
    [
      // A month built by the FIXED engine: the deduction is 11% of the wage, so variance is 0.
      makeRecord({ hrId: "B-100", fullName: "Ahmed", socialInsurance: 1837, employmentIncomeTax: 5000 }),
      // PRODUCTION'S SHAPE, August 2026: the deduction is the raw employee column and is 11% of
      // nothing. The old code turned 2,400 into a subject wage of 21,818.18 — over the legal
      // ceiling, on the document the insurance office reads.
      makeRecord({ hrId: "B-101", fullName: "Mona", socialInsurance: 2400, employmentIncomeTax: 1431.33 }),
      makeRecord({ hrId: "B-102", fullName: "Youssef", socialInsurance: 1837, employmentIncomeTax: 900 }),
      makeRecord({ hrId: "B-103", fullName: "Nadia", socialInsurance: 500, employmentIncomeTax: 0 }),
    ],
    DEFAULT_STATUTORY_CONFIG,
    wages,
  );

  // Wage 16,700 -> employee 11% = 1,837, employer 18.75% = 3,131.25. Deducted matches, so no gap.
  assert.equal(rows[0].subjectWage, 16700);
  assert.equal(rows[0].employeeSi, 1837);
  assert.equal(rows[0].employerSi, 3131.25);
  assert.equal(rows[0].totalSi, 4968.25);
  assert.equal(rows[0].deductedEmployeeSi, 1837);
  assert.equal(rows[0].variance, 0, "a month built from the wage has nothing to reconcile");
  assert.equal(rows[0].incomeTax, 5000);

  // THE HEADLINE. The wage decides the filing; the deduction is reported beside it, not folded in.
  assert.equal(
    rows[1].subjectWage,
    7700,
    "the subject wage must come from the employee's own insurance wage — reconstructing it from " +
      "the 2,400 deduction yields 21,818.18, which is above the 16,700 legal ceiling and is what " +
      "this document used to print for 90 of 100 people",
  );
  assert.equal(rows[1].employeeSi, 847, "11% of 7,700 — from the wage, not from the deduction");
  assert.equal(rows[1].employerSi, 1443.75, "18.75% of the WAGE, never a ratio off a wrong employee share");
  assert.equal(rows[1].deductedEmployeeSi, 2400, "what the payslip actually took is carried, not derived");
  assert.equal(rows[1].variance, 1553, "2,400 deducted against 847 filed — the gap is shown, not hidden");

  // A wage over the ceiling is clamped on the way in, so an over-ceiling filing is unreachable.
  assert.equal(rows[2].subjectWage, 16700, "40,000 clamps to the statutory ceiling");
  assert.equal(rows[2].employeeSi, 1837);

  // No wage on file is a state of its own — never a zero, and never a number invented by division.
  assert.equal(rows[3].subjectWage, null);
  assert.equal(rows[3].employeeSi, null);
  assert.equal(rows[3].employerSi, null);
  assert.equal(rows[3].totalSi, null);
  assert.equal(rows[3].variance, null);
  assert.equal(rows[3].deductedEmployeeSi, 500, "what was deducted is still reported");

  // Totals: the insured payroll is what the filing is assessed on, and it counts only the people
  // who have a wage. 16,700 + 7,700 + 16,700 = 41,100 — Nadia is absent and the count says so.
  assert.equal(totals.insuredPayroll, 41100);
  assert.equal(totals.withoutWage, 1);
  assert.equal(totals.withVariance, 1, "only Mona's deduction disagrees with her own wage");
  assert.equal(totals.employeeSi, 4521); // 1837 + 847 + 1837
  assert.equal(totals.employerSi, 7706.25); // 3131.25 + 1443.75 + 3131.25
  assert.equal(totals.totalSi, 12227.25);
  assert.equal(totals.deductedEmployeeSi, 6574); // 1837 + 2400 + 1837 + 500
  assert.equal(totals.incomeTax, 7331.33);

  // The insured payroll can never exceed the ceiling times the number of assessed people. This is
  // the invariant the old form broke: it reported 2,626,960.36 on a true 1,214,513.00.
  const assessed = rows.filter((row) => row.subjectWage !== null).length;
  assert.ok(
    totals.insuredPayroll <= assessed * DEFAULT_STATUTORY_CONFIG.siMaxMonthlyWage,
    "the insured payroll cannot exceed the ceiling times the number of people assessed",
  );
}
