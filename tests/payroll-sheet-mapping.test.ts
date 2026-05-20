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
  assert.equal(row.monthSalary, 18791);
  assert.equal(row.paymentMode, "two_parts");
  assert.equal(row.payrollComment, "Manual adjustment");
  assert.equal(
    result.validationWarnings.some(
      (warning) => warning.code === "first_part_formula_mismatch",
    ),
    false,
  );
  assert.equal(
    result.validationWarnings.some(
      (warning) => warning.code === "second_part_formula_mismatch",
    ),
    false,
  );
  assert.equal(result.validationTotals.grossSalary, 21506);
  assert.equal(result.validationTotals.netSalary, 19000);
  assert.equal(result.validationTotals.monthSalary, 18791);
  assert.equal(result.validationTotals.totalAdditions, 3125);
  assert.equal(result.validationTotals.totalDeductions, 5840);
  assert.equal(result.validationTotals.firstPart, 11550);
  assert.equal(result.validationTotals.secondPart, 7241);

  const invalidHireDateWorkbook = new ExcelJS.Workbook();
  const invalidHireDateSheet = invalidHireDateWorkbook.addWorksheet("Payroll");
  invalidHireDateSheet.addRow(["HR_ID", "Full Name", "Gross Salary", "Net Salary", "Hire Date"]);
  invalidHireDateSheet.addRow(["B-61", "Invalid Hire Date", 900, 900, "Head office"]);
  const invalidHireDateFile = new File([await invalidHireDateWorkbook.xlsx.writeBuffer() as BlobPart], "invalid-hire-date.xlsx");
  const invalidHireDateResult = await validateSalaryWorkbook(invalidHireDateFile);

  assert.equal(invalidHireDateResult.failedRows, 0);
  assert.equal(invalidHireDateResult.rowsToImport[0].hireDate, null);

  const unknownEmployeeWorkbook = new ExcelJS.Workbook();
  const unknownEmployeeSheet = unknownEmployeeWorkbook.addWorksheet("Payroll");
  unknownEmployeeSheet.addRow(["HR_ID", "Full Name", "Gross Salary", "Net Salary"]);
  unknownEmployeeSheet.addRow(["B-404", "Missing Employee", 900, 900]);
  const unknownEmployeeFile = new File([await unknownEmployeeWorkbook.xlsx.writeBuffer() as BlobPart], "unknown-employee.xlsx");
  const unknownEmployeeResult = await validateSalaryWorkbook(unknownEmployeeFile, {
    expectedPeriod: { month: 1, year: 2026 },
    salarySources: new Map(),
  });

  assert.equal(unknownEmployeeResult.failedRows, 0);
  assert.equal(unknownEmployeeResult.rowsToImport.length, 1);
  assert.equal(unknownEmployeeResult.rowsToImport[0].hrId, "B-404");
  assert.equal(unknownEmployeeResult.validationTotals.grossSalary, 900);
  assert.equal(unknownEmployeeResult.validationTotals.netSalary, 900);
  assert.deepEqual(unknownEmployeeResult.payrollResignationCandidates, [
    {
      area: null,
      fullName: "Missing Employee",
      hireDate: null,
      hrId: "B-404",
      jobTitle: null,
      lastPayoutMonth: 1,
      lastPayoutYear: 2026,
      line: null,
      nameAr: null,
      row: 2,
    },
  ]);
  assert.equal(
    unknownEmployeeResult.validationWarnings.some(
      (warning) => warning.code === "employee_not_found" && warning.hrId === "B-404",
    ),
    true,
  );
  assert.equal(unknownEmployeeResult.warningRows, 0);

  const mixedEmployeeWorkbook = new ExcelJS.Workbook();
  const mixedEmployeeSheet = mixedEmployeeWorkbook.addWorksheet("Payroll");
  mixedEmployeeSheet.addRow(["HR_ID", "Full Name", "Gross Salary", "Net Salary"]);
  mixedEmployeeSheet.addRow(["B-405", "Known Employee", 900, 900]);
  mixedEmployeeSheet.addRow(["B-406", "Missing Employee", 1800, 1800]);
  const mixedEmployeeFile = new File([await mixedEmployeeWorkbook.xlsx.writeBuffer() as BlobPart], "mixed-employee.xlsx");
  const mixedEmployeeSource: PayrollSalarySource = {
    baseSalary: null,
    employmentIncomeTax: null,
    extraCostOfLiving: null,
    fuelAllowance: null,
    grossSalary: null,
    netSalary: null,
    paymentMode: "two_parts",
    socialInsurance: null,
  };
  const mixedEmployeeResult = await validateSalaryWorkbook(mixedEmployeeFile, {
    expectedPeriod: { month: 1, year: 2026 },
    salarySources: new Map(salarySourceLookupKeys("B-405").map((key) => [key, mixedEmployeeSource])),
  });

  assert.equal(mixedEmployeeResult.failedRows, 0);
  assert.deepEqual(mixedEmployeeResult.rowsToImport.map((item) => item.hrId), ["B-405", "B-406"]);
  assert.equal(mixedEmployeeResult.validationTotals.grossSalary, 2700);
  assert.equal(mixedEmployeeResult.validationTotals.netSalary, 2700);
  assert.deepEqual(mixedEmployeeResult.payrollResignationCandidates.map((item) => item.hrId), ["B-406"]);

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
    "Payment Group",
  ]);
  sourceSheet.addRow([
    "B-58",
    "Source Truth Employee",
    18000,
    18000,
    88888,
    300,
    999,
    999,
    999,
    999,
    100,
    200,
    2298,
    2298,
    44444,
    -123,
    "One Part",
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

  assert.equal(sourceRow.netSalary, 18000);
  assert.equal(sourceRow.extraCostOfLiving, 999);
  assert.equal(sourceRow.fuelAllowance, 999);
  assert.equal(sourceRow.socialInsurance, 999);
  assert.equal(sourceRow.employmentIncomeTax, 999);
  assert.equal(sourceRow.grossSalary, 18000);
  assert.equal(sourceRow.firstPart, 44444);
  assert.equal(sourceRow.secondPart, -123);
  assert.equal(sourceRow.totalAdditions, 2298);
  assert.equal(sourceRow.totalDeductions, 2298);
  assert.equal(
    sourceResult.validationWarnings.some(
      (warning) => warning.code === "net_salary_source_of_truth_mismatch",
    ),
    true,
  );
  assert.equal(
    sourceResult.validationWarnings.some(
      (warning) =>
        warning.code === "first_part_formula_mismatch" ||
        warning.code === "second_part_formula_mismatch",
    ),
    false,
  );
  assert.equal(
    sourceResult.validationWarnings.some(
      (warning) => warning.code === "payment_mode_source_of_truth_mismatch",
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
  blankSheet.addRow(["B-99", "Blank Explicit Parts", 9000, 9000, 4, 2026, "", "", "", ""]);
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
  zeroSheet.addRow(["B-100", "Zero Explicit Parts", 9000, 9000, 4, 2026, 0, 0, 0, 0]);
  const zeroFile = new File([await zeroWorkbook.xlsx.writeBuffer() as BlobPart], "zero-payroll.xlsx");
  const zeroResult = await validateSalaryWorkbook(zeroFile, { expectedPeriod: { month: 4, year: 2026 } });
  assert.equal(zeroResult.failedRows, 0);
  assert.equal(zeroResult.rowsToImport[0].totalAdditions, 0);
  assert.equal(zeroResult.rowsToImport[0].totalDeductions, 0);
  assert.equal(zeroResult.rowsToImport[0].firstPart, 0);
  assert.equal(zeroResult.rowsToImport[0].secondPart, 0);

  const formulaMismatchWorkbook = new ExcelJS.Workbook();
  const formulaMismatchSheet = formulaMismatchWorkbook.addWorksheet("Payroll");
  formulaMismatchSheet.addRow([
    "HR_ID",
    "Full Name",
    "gross_salary",
    "Net Salary",
    "expenses",
    "incentive",
    "extra_cost_of_living",
    "fuel_allowance",
    "other_additions",
    "total_additions",
    "Social Insurance",
    "Employment Income Tax",
    "Governmental Deductions",
    "CRM",
    "Medical Insurance",
    "Other Deductions",
    "total_deductions",
  ]);
  formulaMismatchSheet.addRow([
    "B-103",
    "Formula Mismatch",
    8500,
    9000,
    100,
    50,
    200,
    500,
    25,
    999,
    120,
    80,
    250,
    10,
    20,
    30,
    999,
  ]);
  const formulaMismatchFile = new File([await formulaMismatchWorkbook.xlsx.writeBuffer() as BlobPart], "formula-mismatch.xlsx");
  const formulaMismatchResult = await validateSalaryWorkbook(formulaMismatchFile);

  assert.equal(formulaMismatchResult.failedRows, 1);
  assert.equal(formulaMismatchResult.rowsToImport.length, 0);
  assert.deepEqual(
    formulaMismatchResult.validationErrors.map((error) => error.code).sort(),
    [
      "governmental_deductions_formula_mismatch",
      "total_additions_formula_mismatch",
      "total_deductions_formula_mismatch",
    ],
  );

  const separatedDeductionsWorkbook = new ExcelJS.Workbook();
  const separatedDeductionsSheet = separatedDeductionsWorkbook.addWorksheet("Payroll");
  separatedDeductionsSheet.addRow([
    "HR_ID",
    "Full Name",
    "gross_salary",
    "Net Salary",
    "Social Insurance",
    "Employment Income Tax",
    "Governmental Deductions",
    "CRM",
    "Medical Insurance",
    "Other Deductions",
    "total_deductions",
  ]);
  separatedDeductionsSheet.addRow([
    "B-104",
    "Separated Deductions",
    9200,
    9000,
    120,
    80,
    200,
    10,
    20,
    30,
    60,
  ]);
  const separatedDeductionsFile = new File([await separatedDeductionsWorkbook.xlsx.writeBuffer() as BlobPart], "separated-deductions.xlsx");
  const separatedDeductionsResult = await validateSalaryWorkbook(separatedDeductionsFile);

  assert.equal(separatedDeductionsResult.failedRows, 0);
  assert.equal(separatedDeductionsResult.rowsToImport[0].governmentalDeductions, 200);
  assert.equal(separatedDeductionsResult.rowsToImport[0].totalDeductions, 60);
  assert.equal(separatedDeductionsResult.validationTotals.governmentalDeductions, 200);
  assert.equal(separatedDeductionsResult.validationTotals.totalDeductions, 60);

  const mismatchWorkbook = new ExcelJS.Workbook();
  const mismatchSheet = mismatchWorkbook.addWorksheet("Payroll");
  mismatchSheet.addRow(["HR_ID", "Full Name", "gross_salary", "Net Salary", "Month", "Year"]);
  mismatchSheet.addRow(["B-101", "Wrong Period", 9000, 9000, 5, 2027]);
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
  noPeriodSheet.addRow(["B-102", "No Period Columns", 9000, 9000]);
  const noPeriodFile = new File([await noPeriodWorkbook.xlsx.writeBuffer() as BlobPart], "no-period.xlsx");
  const noPeriodResult = await validateSalaryWorkbook(noPeriodFile, { expectedPeriod: { month: 4, year: 2026 } });
  assert.equal(noPeriodResult.failedRows, 0);
  assert.equal(noPeriodResult.payrollPeriod.month, 4);
  assert.equal(noPeriodResult.payrollPeriod.year, 2026);

  const repeatedHeaderWorkbook = new ExcelJS.Workbook();
  const repeatedHeaderSheet = repeatedHeaderWorkbook.addWorksheet("Payroll");
  const repeatedHeaders = ["HR_ID", "Full Name", "Gross Salary", "Net Salary"];
  repeatedHeaderSheet.addRow(repeatedHeaders);
  repeatedHeaderSheet.addRow(["B-201", "Before Sort Header", 1000, 1000]);
  repeatedHeaderSheet.addRow(repeatedHeaders);
  repeatedHeaderSheet.addRow(["B-202", "After Sort Header", 2000, 2000]);
  const repeatedHeaderFile = new File([await repeatedHeaderWorkbook.xlsx.writeBuffer() as BlobPart], "repeated-header.xlsx");
  const repeatedHeaderResult = await validateSalaryWorkbook(repeatedHeaderFile);

  assert.equal(repeatedHeaderResult.failedRows, 0);
  assert.deepEqual(repeatedHeaderResult.rowsToImport.map((item) => item.hrId), ["B-201", "B-202"]);

  const baseSalaryWorkbook = new ExcelJS.Workbook();
  const baseSalarySheet = baseSalaryWorkbook.addWorksheet("Payroll");
  baseSalarySheet.addRow([
    "HR_ID",
    "Full Name",
    "Base Salary",
    "Gross Salary",
    "Net Salary",
    "Extra Cost of Living",
    "Fuel Allowance",
    "Social Insurance",
    "Employment Income Tax",
    "Governmental Deductions",
    "Payment Group",
  ]);
  baseSalarySheet.addRow([
    "B-58",
    "Base Salary Employee",
    14000,
    "",
    "",
    2000,
    500,
    1200,
    800,
    2000,
    "Two Parts",
  ]);
  baseSalarySheet.addRow([
    "",
    "",
    14000,
    16000,
    16500,
    2000,
    500,
    1200,
    800,
    2000,
    "",
  ]);
  const baseSalaryFile = new File([await baseSalaryWorkbook.xlsx.writeBuffer() as BlobPart], "base-salary-payroll.xlsx");
  const baseSalaryResult = await validateSalaryWorkbook(baseSalaryFile);
  const baseSalaryRow = baseSalaryResult.rowsToImport[0];

  assert.equal(baseSalaryResult.failedRows, 0);
  assert.equal(baseSalaryResult.totalRows, 1);
  assert.equal(baseSalaryResult.rowsToImport.length, 1);
  assert.equal(baseSalaryRow.netSalary, 16500);
  assert.equal(baseSalaryRow.grossSalary, 16000);
  assert.equal(baseSalaryRow.firstPart, 9800);
  assert.equal(baseSalaryRow.secondPart, 6700);
  assert.equal(baseSalaryRow.monthSalary, 16500);
  assert.equal(baseSalaryRow.totalDeductions, 0);
  assert.equal(baseSalaryResult.validationTotals.baseSalary, 14000);
  assert.equal(baseSalaryResult.validationTotals.grossSalary, 16000);
  assert.equal(baseSalaryResult.validationTotals.netSalary, 16500);
  assert.equal(baseSalaryResult.validationTotals.monthSalary, 16500);
  assert.equal(baseSalaryResult.validationTotals.totalAdditions, 2500);
  assert.equal(baseSalaryResult.validationTotals.governmentalDeductions, 2000);
  assert.equal(baseSalaryResult.validationTotals.totalDeductions, 0);

  const uploadedFixedWorkbook = new ExcelJS.Workbook();
  const uploadedFixedSheet = uploadedFixedWorkbook.addWorksheet("Payroll");
  uploadedFixedSheet.addRow([
    "HR_ID",
    "Full Name",
    "Base Salary",
    "Gross Salary",
    "Net Salary",
    "Social Insurance",
    "Employment Income Tax",
    "Payment Group",
  ]);
  uploadedFixedSheet.addRow(["B-60", "Uploaded Fixed Values", 100, 999, 888, 10, 20, "Two Parts"]);
  const uploadedFixedFile = new File([await uploadedFixedWorkbook.xlsx.writeBuffer() as BlobPart], "uploaded-fixed.xlsx");
  const uploadedFixedResult = await validateSalaryWorkbook(uploadedFixedFile);

  assert.equal(uploadedFixedResult.failedRows, 1);
  assert.deepEqual(
    uploadedFixedResult.validationErrors.map((error) => error.code).sort(),
    ["gross_salary_formula_mismatch", "net_salary_formula_mismatch"],
  );

  const governmentalMismatchWorkbook = new ExcelJS.Workbook();
  const governmentalMismatchSheet = governmentalMismatchWorkbook.addWorksheet("Payroll");
  governmentalMismatchSheet.addRow([
    "HR_ID",
    "Full Name",
    "gross_salary",
    "Net Salary",
    "Social Insurance",
    "Employment Income Tax",
    "Governmental Deductions",
  ]);
  governmentalMismatchSheet.addRow(["B-59", "Government Deduction Mismatch", 11000, 9000, 1200, 800, 2500]);
  const governmentalMismatchFile = new File([await governmentalMismatchWorkbook.xlsx.writeBuffer() as BlobPart], "gov-mismatch.xlsx");
  const governmentalMismatchResult = await validateSalaryWorkbook(governmentalMismatchFile);

  assert.equal(governmentalMismatchResult.failedRows, 1);
  assert.equal(governmentalMismatchResult.rowsToImport.length, 0);
  assert.equal(
    governmentalMismatchResult.validationErrors.some(
      (error) => error.code === "governmental_deductions_formula_mismatch",
    ),
    true,
  );
}
