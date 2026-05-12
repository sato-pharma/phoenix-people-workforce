import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { validateSalaryWorkbook } from "../src/lib/payroll/salary-import.ts";
import {
  salarySourceLookupKeys,
  type PayrollSalarySource,
} from "../src/lib/payroll/salary-source-model.ts";

export async function runPayrollSheetMappingTests() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Payroll");

  sheet.addRow(["Phoenix payroll"]);
  sheet.addRow([]);
  sheet.addRow([
    "HR_ID",
    "name_ar",
    "name",
    "line",
    "job_title",
    "area",
    "hiring_date",
    "gross_salary",
    "expenses",
    "incentive",
    "overtime",
    "bonus",
    "extra_cost_of_living",
    "fuel_allowance",
    "other_additions",
    "total_additions",
    "social_insurance",
    "employment_income_taxes",
    "no_crm_entery",
    "finger_print",
    "unpaid_vacation",
    "medical_insurance",
    "loans",
    "other_deductions",
    "total_deductions",
    "net_salary",
    "first_part",
    "second_part",
    "Comment",
  ]);
  sheet.addRow([
    "B-167",
    "محمود محمد حسن الطنانى",
    "Mahmoud Mohamed Hassan Eltanany",
    "Pedia",
    "Medical Representative",
    "Behira 1",
    new Date(Date.UTC(2026, 2, 14)),
    21506,
    0,
    100,
    200,
    300,
    2000,
    500,
    25,
    3125,
    3173,
    1833,
    550,
    10,
    20,
    184,
    30,
    40,
    5840,
    19000,
    11550,
    7241,
    "Manual adjustment",
  ]);

  const buffer = await workbook.xlsx.writeBuffer();
  const file = new File([buffer as BlobPart], "payroll.xlsx");
  const result = await validateSalaryWorkbook(file);
  const row = result.rowsToImport[0];

  assert.equal(row.hrId, "B-167");
  assert.equal(row.fullName, "Mahmoud Mohamed Hassan Eltanany");
  assert.equal(row.nameAr, "محمود محمد حسن الطنانى");
  assert.equal(row.hireDate, "2026-03-14");
  assert.equal(row.grossSalary, 21506);
  assert.equal(row.netSalary, 19000);
  assert.equal(row.expenses, 0);
  assert.equal(row.incentive, 100);
  assert.equal(row.overtime, 200);
  assert.equal(row.bonus, 300);
  assert.equal(row.extraCostOfLiving, 2000);
  assert.equal(row.fuelAllowance, 500);
  assert.equal(row.otherAdditions, 25);
  assert.equal(row.totalAdditions, 3125);
  assert.equal(row.socialInsurance, 3173);
  assert.equal(row.employmentIncomeTax, 1833);
  assert.equal(row.crm, 550);
  assert.equal(row.fingerPrint, 10);
  assert.equal(row.unpaidVacations, 20);
  assert.equal(row.medicalInsurance, 184);
  assert.equal(row.loans, 30);
  assert.equal(row.otherDeductions, 40);
  assert.equal(row.totalDeductions, 5840);
  assert.equal(row.firstPart, 11550);
  assert.equal(row.secondPart, 7241);
  assert.equal(row.paymentMode, "two_parts");
  assert.equal(row.payrollComment, "Manual adjustment");
  assert.equal(
    result.validationWarnings.some(
      (warning) => warning.code === "first_part_formula_mismatch",
    ),
    false,
  );

  const sourceWorkbook = new ExcelJS.Workbook();
  const sourceSheet = sourceWorkbook.addWorksheet("Payroll");
  sourceSheet.addRow([
    "HR_ID",
    "Full Name",
    "gross_salary",
    "Net Salary",
    "Month Salary",
    "expenses",
    "extra_cost_of_living",
    "fuel_allowance",
    "social_insurance",
    "employment_income_taxes",
    "unpaid_vacation",
    "medical_insurance",
    "total_additions",
    "total_deductions",
    "first_part",
    "second_part",
  ]);
  sourceSheet.addRow([
    "B-58",
    "Source Truth Employee",
    11111,
    99999,
    88888,
    300,
    999,
    999,
    999,
    999,
    100,
    200,
    7777,
    8888,
    44444,
    -123,
  ]);

  const b58Source: PayrollSalarySource = {
    baseSalary: 14000,
    employmentIncomeTax: 800,
    extraCostOfLiving: 2000,
    fuelAllowance: 1000,
    grossSalary: null,
    netSalary: 17000,
    paymentMode: "two_parts",
    socialInsurance: 1200,
  };
  const salarySources = new Map(
    salarySourceLookupKeys("B-58").map((key) => [key, b58Source]),
  );
  const sourceBuffer = await sourceWorkbook.xlsx.writeBuffer();
  const sourceFile = new File([sourceBuffer as BlobPart], "payroll-source.xlsx");
  const sourceResult = await validateSalaryWorkbook(sourceFile, { salarySources });
  const sourceRow = sourceResult.rowsToImport[0];

  assert.equal(sourceRow.netSalary, 99999);
  assert.equal(sourceRow.extraCostOfLiving, 999);
  assert.equal(sourceRow.fuelAllowance, 999);
  assert.equal(sourceRow.socialInsurance, 999);
  assert.equal(sourceRow.employmentIncomeTax, 999);
  assert.equal(sourceRow.grossSalary, 11111);
  assert.equal(sourceRow.firstPart, 44444);
  assert.equal(sourceRow.secondPart, -123);
  assert.equal(sourceRow.totalAdditions, 7777);
  assert.equal(sourceRow.totalDeductions, 8888);
  assert.equal(
    sourceResult.validationWarnings.some(
      (warning) => warning.code === "net_salary_source_of_truth_mismatch",
    ),
    true,
  );

  const blankWorkbook = new ExcelJS.Workbook();
  const blankSheet = blankWorkbook.addWorksheet("Payroll");
  blankSheet.addRow([
    "HR_ID",
    "Full Name",
    "gross_salary",
    "Net Salary",
    "Month",
    "Year",
    "total_additions",
    "total_deductions",
    "first_part",
    "second_part",
  ]);
  blankSheet.addRow(["B-99", "Blank Explicit Parts", 10000, 9000, 4, 2026, "", "", "", ""]);
  const blankFile = new File([await blankWorkbook.xlsx.writeBuffer() as BlobPart], "blank-payroll.xlsx");
  const blankResult = await validateSalaryWorkbook(blankFile, { expectedPeriod: { month: 4, year: 2026 } });
  assert.equal(blankResult.failedRows, 1);
  assert.deepEqual(
    blankResult.validationErrors.map((error) => error.code).sort(),
    ["missing_first_part", "missing_second_part", "missing_total_additions", "missing_total_deductions"],
  );

  const zeroWorkbook = new ExcelJS.Workbook();
  const zeroSheet = zeroWorkbook.addWorksheet("Payroll");
  zeroSheet.addRow([
    "HR_ID",
    "Full Name",
    "gross_salary",
    "Net Salary",
    "Month",
    "Year",
    "total_additions",
    "total_deductions",
    "first_part",
    "second_part",
  ]);
  zeroSheet.addRow(["B-100", "Zero Explicit Parts", 10000, 9000, 4, 2026, 0, 0, 0, 0]);
  const zeroFile = new File([await zeroWorkbook.xlsx.writeBuffer() as BlobPart], "zero-payroll.xlsx");
  const zeroResult = await validateSalaryWorkbook(zeroFile, { expectedPeriod: { month: 4, year: 2026 } });
  assert.equal(zeroResult.failedRows, 0);
  assert.equal(zeroResult.rowsToImport[0].totalAdditions, 0);
  assert.equal(zeroResult.rowsToImport[0].totalDeductions, 0);
  assert.equal(zeroResult.rowsToImport[0].firstPart, 0);
  assert.equal(zeroResult.rowsToImport[0].secondPart, 0);

  const mismatchWorkbook = new ExcelJS.Workbook();
  const mismatchSheet = mismatchWorkbook.addWorksheet("Payroll");
  mismatchSheet.addRow(["HR_ID", "Full Name", "gross_salary", "Net Salary", "Month", "Year"]);
  mismatchSheet.addRow(["B-101", "Wrong Period", 10000, 9000, 5, 2027]);
  const mismatchFile = new File([await mismatchWorkbook.xlsx.writeBuffer() as BlobPart], "wrong-period.xlsx");
  const mismatchResult = await validateSalaryWorkbook(mismatchFile, { expectedPeriod: { month: 4, year: 2026 } });
  assert.equal(mismatchResult.failedRows, 1);
  assert.equal(
    mismatchResult.validationErrors.some((error) => error.code === "payroll_month_mismatch"),
    true,
  );
  assert.equal(
    mismatchResult.validationErrors.some((error) => error.code === "payroll_year_mismatch"),
    true,
  );

  const noPeriodWorkbook = new ExcelJS.Workbook();
  const noPeriodSheet = noPeriodWorkbook.addWorksheet("Payroll");
  noPeriodSheet.addRow(["HR_ID", "Full Name", "gross_salary", "Net Salary"]);
  noPeriodSheet.addRow(["B-102", "No Period Columns", 10000, 9000]);
  const noPeriodFile = new File([await noPeriodWorkbook.xlsx.writeBuffer() as BlobPart], "no-period.xlsx");
  const noPeriodResult = await validateSalaryWorkbook(noPeriodFile, { expectedPeriod: { month: 4, year: 2026 } });
  assert.equal(noPeriodResult.failedRows, 0);
  assert.equal(noPeriodResult.payrollPeriod.month, 4);
  assert.equal(noPeriodResult.payrollPeriod.year, 2026);
}
