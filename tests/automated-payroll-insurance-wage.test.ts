import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { assembleRows } from "../src/lib/automated-payroll/assemble.ts";
import { auditPayrollDataQuality, payAffectingIssues } from "../src/lib/automated-payroll/data-quality.ts";
import type { PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import type { PayrollPeriod } from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";
import {
  buildStatutorySummaryRows,
  buildStatutorySummaryWorkbook,
  NO_INSURANCE_WAGE_CELL,
  STATUTORY_SUMMARY_HEADERS,
} from "../src/lib/payroll/exports/statutory-summary.ts";
import { DEFAULT_STATUTORY_CONFIG } from "../src/lib/payroll/statutory/config.ts";
import type { SalaryRecord } from "../src/lib/payroll/types.ts";

/**
 * Automated Payroll files the statutory insurance from the employee's INSURANCE WAGE.
 *
 * THE DEFECT. The engine copied `employees.social_insurance` straight onto the row. That column is
 * a stored figure nobody derives and nobody validates; the column that decides the filing is
 * `social_insurance_wage`. Measured on production's published August 2026 batch, 100 records:
 * 94 carried exactly the raw column and NOT ONE carried 11% of that person's clamped wage. The
 * Payroll Copilot has always computed from the wage, so the same person could be filed at two
 * different amounts depending on which engine happened to build the month.
 *
 * NOBODY'S PAY MOVES. Social insurance is reported as a governmental deduction and is absent from
 * `totalDeductions` and from everything `assembleParts` is handed — the company absorbs it. The
 * test below pins that explicitly, because "we changed a deduction" reads like a pay change and
 * this one is not: it is a filing change.
 */

const JUNE: PayrollPeriod = { month: 6, year: 2026 };
const BASE = 30000;
const NET = 31500;

function compact(hrId: string): string {
  return hrId.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function member(hrId: string): PopulationMember {
  return {
    employee: {
      hrId,
      fullName: `Employee ${hrId}`,
      nameAr: null,
      jobTitle: "Medical Representative",
      lineName: "Anti Infective",
      areaName: "Cairo",
      hireDate: "2024-01-01",
      medicalInsurance: 0,
      bankName: "NBE",
      bankAccount: "123456",
      lastWorkingDate: null,
    } as unknown as EmployeeDirectoryRow,
    compact: compact(hrId),
    lifecycle: "regular",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
  };
}

/** `carriedSocialInsurance` is the raw employee-master column — what the engine used to publish. */
function sources(hrIds: string[], carriedSocialInsurance: number): Map<string, PayrollSalarySource> {
  const source: PayrollSalarySource = {
    baseSalary: BASE,
    extraCostOfLiving: 0,
    fuelAllowance: 0,
    netSalary: NET,
    grossSalary: BASE,
    socialInsurance: carriedSocialInsurance,
    employmentIncomeTax: 0,
    paymentMode: "two_parts",
  };
  const map = new Map<string, PayrollSalarySource>();
  for (const hrId of hrIds) {
    map.set(hrId.toLowerCase(), source);
    map.set(compact(hrId), source);
  }
  return map;
}

export async function runAutomatedPayrollInsuranceWageTests() {
  const withWage = "B-1";
  const overCeiling = "B-2";
  const noWage = "B-3";
  const members = [member(withWage), member(overCeiling), member(noWage)];
  // 2,400 is production's shape: a stored figure that is 11% of nothing.
  const CARRIED = 2400;
  const insuranceWages = new Map<string, number | null>([
    [compact(withWage), 7700],
    [compact(overCeiling), 40000],
    [compact(noWage), null],
  ]);

  const rows = assembleRows({
    members,
    sources: sources([withWage, overCeiling, noWage], CARRIED),
    draftRows: [],
    period: JUNE,
    statutory: { config: DEFAULT_STATUTORY_CONFIG, insuranceWages },
  });
  const byHr = new Map(rows.map((row) => [row.row.hrId, row]));

  // ---- HEADLINE: the wage decides the figure, not the stored column ---------------------------
  assert.equal(
    byHr.get(withWage)?.row.socialInsurance,
    847,
    "social insurance must be 11% of the employee's own clamped insurance wage (11% of 7,700). " +
      `The engine used to publish the raw ${CARRIED} off the employee master, which is 11% of nothing`,
  );

  // A wage above the ceiling is clamped before anything is computed from it, so an over-ceiling
  // filing is unreachable rather than merely unlikely.
  assert.equal(
    byHr.get(overCeiling)?.row.socialInsurance,
    1837,
    "40,000 clamps to the 16,700 ceiling, so the filing is 11% of 16,700",
  );

  // ---- No wage on file: carry, do not invent ---------------------------------------------------
  assert.equal(
    byHr.get(noWage)?.row.socialInsurance,
    CARRIED,
    "with no wage on file there is nothing to compute from, so the master's figure is carried " +
      "rather than replaced by a confident zero",
  );

  // ---- NOBODY'S PAY MOVES ----------------------------------------------------------------------
  // The three people are identical apart from their insurance wage. If social insurance touched
  // pay, their instalments would differ.
  const payable = rows.map((row) => row.totalPayable);
  assert.deepEqual(
    new Set(payable),
    new Set([payable[0]]),
    "three people on the same salary must be paid the same regardless of their insurance wage — " +
      "the company absorbs social insurance, so it never reaches take-home",
  );
  for (const row of rows) {
    assert.equal(
      row.row.totalDeductions,
      0,
      "social insurance must not appear in totalDeductions — that total is what reduces pay",
    );
    assert.equal(
      row.row.governmentalDeductions,
      row.row.socialInsurance + row.row.employmentIncomeTax,
      "the statutory pair is reported here, and only here",
    );
    assert.equal(
      row.row.grossSalary,
      row.row.baseSalary + row.row.socialInsurance + row.row.employmentIncomeTax,
      "Gross = Base + SI + Tax still reads true across the row",
    );
  }

  // ---- Omitting the map keeps the old behaviour exactly ----------------------------------------
  // A caller that does not need statutory figures must not be forced to load them, and must not
  // silently get zeros for having skipped it.
  const withoutStatutory = assembleRows({
    members,
    sources: sources([withWage, overCeiling, noWage], CARRIED),
    draftRows: [],
    period: JUNE,
  });
  for (const row of withoutStatutory) {
    assert.equal(row.row.socialInsurance, CARRIED, "no statutory input means carry, unchanged");
  }

  // ---- The missing wage announces itself --------------------------------------------------------
  const report = auditPayrollDataQuality({
    members,
    sources: sources([withWage, overCeiling, noWage], CARRIED),
    draftRows: [],
    part1Confirmed: false,
    insuranceWages,
  });
  const flagged = report.rows.filter((row) => row.issues.includes("missing_insurance_wage"));
  assert.deepEqual(
    flagged.map((row) => row.hrId),
    [noWage],
    "exactly the person with no wage on file is named, so the carried fallback is never silent",
  );

  // ...unless the employee record says the company does not insure them at all. A government
  // secondment is insured through the government, so no wage is missing (owner, 2026-11-09: three
  // such people were listed as "missing payroll data that decides their pay").
  const secondedReport = auditPayrollDataQuality({
    members,
    sources: sources([withWage, overCeiling, noWage], CARRIED),
    draftRows: [],
    part1Confirmed: false,
    insuranceWages,
    notCompanyInsured: new Set([compact(noWage)]),
  });
  assert.equal(
    secondedReport.rows.filter((row) => row.issues.includes("missing_insurance_wage")).length,
    0,
    "a person the company does not insure has no missing insurance wage to report",
  );
  // A wage on file still files them — the status never decides the filing, only the flag.
  const insuredElsewhereWithWage = auditPayrollDataQuality({
    members,
    sources: sources([withWage, overCeiling, noWage], CARRIED),
    draftRows: [],
    part1Confirmed: false,
    insuranceWages,
    notCompanyInsured: new Set([compact(withWage)]),
  });
  assert.deepEqual(
    insuredElsewhereWithWage.rows.filter((row) => row.issues.includes("missing_insurance_wage")).map((row) => row.hrId),
    [noWage],
    "the exemption is keyed per person — marking someone else leaves the real gap flagged",
  );

  // ...but it does not hold up a confirm, because it moves nobody's money.
  assert.equal(
    payAffectingIssues(report).total,
    0,
    "a filing gap must not gate a payroll confirm — the gate is for issues that change what " +
      "somebody is PAID, and acknowledging one that does not is how a gate stops being read",
  );

  // ---- THE EMITTED WORKBOOK, not the code that writes it ---------------------------------------
  //
  // Reading the source cannot see a column added without a value beside it: every cell to its right
  // shifts one place and the file still opens. Three defects shipped here in one night, each
  // "verified" by reading the source. So build the real sheet and read the cells back.
  const summary = buildStatutorySummaryRows(
    [
      salaryRecord({ hrId: "B-1", fullName: "Filed", socialInsurance: 847, employmentIncomeTax: 100 }),
      salaryRecord({ hrId: "B-3", fullName: "No Wage", socialInsurance: 500, employmentIncomeTax: 0 }),
    ],
    DEFAULT_STATUTORY_CONFIG,
    insuranceWages,
  );
  const sheet = buildStatutorySummaryWorkbook(summary).getWorksheet("Statutory Summary");
  assert.ok(sheet, "the workbook must carry a Statutory Summary sheet");

  const headerRow = sheet.getRow(1);
  assert.deepEqual(
    STATUTORY_SUMMARY_HEADERS.map((_, index) => headerRow.getCell(index + 1).value),
    [...STATUTORY_SUMMARY_HEADERS],
    "every declared column must actually be written",
  );

  // Row 2 is the person with a wage: the sheet shows the FILED figure and the DEDUCTED one apart.
  const filedRow = sheet.getRow(2);
  assert.equal(filedRow.getCell(1).value, "B-1");
  assert.equal(filedRow.getCell(3).value, 7700, "Subject Wage cell carries the wage, not a quotient");
  assert.equal(filedRow.getCell(4).value, 847);
  assert.equal(filedRow.getCell(7).value, 847, "what the payslip deducted");
  assert.equal(filedRow.getCell(8).value, 0, "no gap for a month built from the wage");

  // Row 3 is the person with none: the cell SAYS so rather than showing a zero or a blank.
  const noWageRow = sheet.getRow(3);
  assert.equal(noWageRow.getCell(3).value, NO_INSURANCE_WAGE_CELL);
  assert.equal(noWageRow.getCell(7).value, 500, "what was deducted is still reported");

  // The TOTAL row's insured payroll counts only the assessed person — 7,700, not 7,700 + something
  // invented for the one with no wage.
  const totalRow = sheet.getRow(4);
  assert.equal(totalRow.getCell(1).value, "TOTAL");
  assert.equal(totalRow.getCell(3).value, 7700);

  // And the sheet says, in words, that somebody is missing from that total.
  const noteText = [5, 6, 7]
    .map((rowNumber) => String(sheet.getRow(rowNumber).getCell(1).value ?? ""))
    .join(" ");
  assert.ok(
    noteText.includes("no insurance wage on file"),
    "a person absent from the insured payroll must be accounted for on the sheet, in words",
  );

  // ---- The wage column has exactly ONE reader ---------------------------------------------------
  // Two engines reading the same column two different ways is what produced two filings for one
  // person. Comments may name the column; code may not, outside the shared module.
  const readers = [
    "src/lib/payroll/copilot/service.ts",
    "src/lib/automated-payroll/assemble.ts",
    "src/lib/payroll/exports/statutory-summary.ts",
  ];
  for (const file of readers) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.ok(
      !code.includes("social_insurance_wage"),
      `${file} must read the insurance wage through statutory/insurance-wages.ts, not query the ` +
        "column itself — a second reader is how the two engines came to disagree",
    );
  }
}

/** Only the fields the statutory summary reads; the cast keeps the fixture small and honest. */
function salaryRecord(overrides: Partial<SalaryRecord>): SalaryRecord {
  return {
    hrId: "B-1",
    employeeCode: "",
    fullName: "Test Employee",
    socialInsurance: 0,
    employmentIncomeTax: 0,
    ...overrides,
  } as unknown as SalaryRecord;
}
