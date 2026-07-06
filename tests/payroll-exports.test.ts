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

  // --- statutory summary (employer SI + subject wage derived from employee SI)
  const { rows, totals } = buildStatutorySummaryRows(
    [
      makeRecord({ hrId: "B-100", fullName: "Ahmed", socialInsurance: 1837, employmentIncomeTax: 5000 }),
      makeRecord({ hrId: "B-101", fullName: "Mona", socialInsurance: 847, employmentIncomeTax: 1431.33 }),
    ],
    DEFAULT_STATUTORY_CONFIG,
  );
  // 1837 = 11% x 16700 → subject wage 16700, employer 18.75% x 16700 = 3131.25
  assert.equal(rows[0].subjectWage, 16700);
  assert.equal(rows[0].employeeSi, 1837);
  assert.equal(rows[0].employerSi, 3131.25);
  assert.equal(rows[0].totalSi, 4968.25);
  assert.equal(rows[0].incomeTax, 5000);
  // 847 = 11% x 7700 → subject wage 7700, employer 18.75% x 7700 = 1443.75
  assert.equal(rows[1].subjectWage, 7700);
  assert.equal(rows[1].employerSi, 1443.75);

  assert.equal(totals.employeeSi, 2684); // 1837 + 847
  assert.equal(totals.employerSi, 4575); // 3131.25 + 1443.75
  assert.equal(totals.totalSi, 7259); // 2684 + 4575
  assert.equal(totals.incomeTax, 6431.33);
}
