import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { validateSalaryWorkbook } from "../src/lib/payroll/salary-import.ts";

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
    18791,
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
  assert.equal(row.netSalary, 18791);
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
  assert.equal(row.payrollComment, "Manual adjustment");
}
