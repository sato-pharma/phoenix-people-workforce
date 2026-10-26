import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import type { AssembledRow } from "../src/lib/automated-payroll/assemble.ts";
import {
  buildCibSheetWorkbook,
  CIB_BRANCH_CODE,
  CIB_CURRENCY,
  CIB_DEBIT_CREDIT,
  CIB_DETAILS_ID,
  CIB_REASON_CODE,
  cibRowsForNonEmployees,
  cibRowsForScope,
  formatCibAmount,
} from "../src/lib/automated-payroll/exports/cib-sheet.ts";
import type { NonEmployeePart, NonEmployeePayrollRow } from "../src/lib/automated-payroll/types.ts";
import type { SalaryValidationRow } from "../src/lib/payroll/salary-import.ts";

/**
 * Guards the CIB (Commercial International Bank) bulk-credit sheet — schema
 * AND styling reverse-engineered cell-by-cell from the company's real
 * "details_Sheet.xls" (see exports/cib-sheet.ts doc comment). The owner's
 * instruction was explicit: "same colors same everything" — so this pins
 * the exact fills/fonts/borders alongside the values, not just the values.
 */

function buildAssembledRow(overrides: {
  hrId?: string;
  fullName?: string;
  firstPart?: number;
  secondPart?: number;
  onHold?: boolean;
  bankName?: string | null;
  bankAccount?: string | null;
}): AssembledRow {
  const row: SalaryValidationRow = {
    area: "Cairo",
    baseSalary: 10000,
    bonus: 0,
    calendarDays: 30,
    crm: 0,
    hrId: overrides.hrId ?? "B-1",
    employmentIncomeTax: 0,
    expenses: 0,
    extraCostOfLiving: 0,
    fingerPrint: 0,
    firstPart: overrides.firstPart ?? 5000,
    fuelAllowance: 0,
    governmentalDeductions: 0,
    fullName: overrides.fullName ?? "Jane Doe",
    grossSalary: 10000,
    hireDate: null,
    incentive: 0,
    jobTitle: "Rep",
    line: "Line 1",
    loans: 0,
    medicalInsurance: 0,
    monthSalary: 10000,
    nameAr: null,
    netSalary: 10000,
    otherAdditions: 0,
    otherDeductions: 0,
    overtime: 0,
    payrollComment: null,
    paymentMode: "two_parts",
    row: 1,
    secondPart: overrides.secondPart ?? 5000,
    socialInsurance: 0,
    totalAdditions: 0,
    totalDeductions: 0,
    unpaidVacations: 0,
    workingDays: 30,
  };
  return {
    row,
    compact: (overrides.hrId ?? "B-1").toLowerCase(),
    onHold: overrides.onHold ?? false,
    overpaidResidual: 0,
    // The engine's own answer for what the month owes. reconcile() compares the split against
    // THIS rather than against monthSalary, which is defined as the split itself.
    totalPayable: (overrides.firstPart ?? 5000) + (overrides.secondPart ?? 5000),
    carriedForwardApplied: 0,
    heldReleaseApplied: 0,
    lifecycle: "regular",
    bankName: overrides.bankName === undefined ? "CIB" : overrides.bankName,
    bankAccount: overrides.bankAccount === undefined ? "100000000001" : overrides.bankAccount,
  };
}

function buildNonEmployeeRow(overrides: {
  fullNameEn?: string;
  totalSalary?: number;
  bankName?: string | null;
  bankAccount?: string | null;
  part?: NonEmployeePart;
}): NonEmployeePayrollRow {
  return {
    id: "id",
    runId: "run",
    part: overrides.part ?? "first",
    fullNameAr: "اسم",
    fullNameEn: overrides.fullNameEn ?? "Non Employee Person",
    totalSalary: overrides.totalSalary ?? 3000,
    bankName: overrides.bankName === undefined ? "CIB" : overrides.bankName,
    bankAccount: overrides.bankAccount === undefined ? "100222220001" : overrides.bankAccount,
    recurringId: null,
    createdBy: null,
    createdAt: "",
    updatedAt: "",
  };
}

export async function runAutomatedPayrollCibSheetTests() {
  // ---- constants pinned to the real, bank-accepted reference file ------------
  assert.equal(CIB_DETAILS_ID, "D");
  assert.equal(CIB_BRANCH_CODE, "042");
  assert.equal(CIB_CURRENCY, "EGP");
  assert.equal(CIB_DEBIT_CREDIT, "C");
  assert.equal(CIB_REASON_CODE, "R");

  // ---- formatCibAmount: amount*100, zero-padded to 13 digits -----------------
  assert.equal(formatCibAmount(11500), "0000001150000");
  assert.equal(formatCibAmount(158487), "0000015848700");
  assert.equal(formatCibAmount(0), "0000000000000");

  // ---- cibRowsForScope: same filtering rules as fabRowsForScope --------------
  const heldRow = buildAssembledRow({ hrId: "B-2", onHold: true, firstPart: 9000, secondPart: 9000 });
  const nonCibRow = buildAssembledRow({ hrId: "B-3", bankName: "FAB", firstPart: 9000, secondPart: 9000 });
  const noAccountRow = buildAssembledRow({ hrId: "B-4", bankAccount: "", firstPart: 9000, secondPart: 9000 });
  const zeroSecondPartRow = buildAssembledRow({ hrId: "B-5", firstPart: 15000, secondPart: 0 });
  const normalRow = buildAssembledRow({ hrId: "B-6", fullName: "Mahmoud Ibrahim Ahmed", firstPart: 11500, secondPart: 6200 });

  const allRows = [heldRow, nonCibRow, noAccountRow, zeroSecondPartRow, normalRow];

  const part1Rows = cibRowsForScope(allRows, "part1");
  assert.equal(part1Rows.length, 2, "held / non-CIB / no-account rows excluded; zeroSecondPartRow survives on firstPart");
  assert.ok(part1Rows.some((r) => r.salary === 15000));
  assert.ok(part1Rows.some((r) => r.fullName === "Mahmoud Ibrahim Ahmed"));

  const part2Rows = cibRowsForScope(allRows, "part2");
  assert.equal(part2Rows.length, 1, "only normalRow has a nonzero Part-2 amount");
  assert.equal(part2Rows[0].salary, 6200);

  // ---- cibRowsForNonEmployees: a completely separate data source from
  // AssembledRow (owner-reported 2026-07-26: they were silently missing from
  // the real bank file because cibRowsForScope never sees them at all) -------
  const neNormal = buildNonEmployeeRow({ fullNameEn: "Freelance Person" });
  const neNonCib = buildNonEmployeeRow({ bankName: "FAB" });
  const neNoAccount = buildNonEmployeeRow({ bankAccount: "" });
  const neZeroSalary = buildNonEmployeeRow({ totalSalary: 0 });
  const allNonEmployees = [neNormal, neNonCib, neNoAccount, neZeroSalary];

  const nePart1 = cibRowsForNonEmployees(allNonEmployees, "part1");
  assert.equal(nePart1.length, 1, "only the real CIB-bank, nonzero, has-account row survives");
  assert.equal(nePart1[0].fullName, "Freelance Person");
  assert.equal(nePart1[0].salary, 3000);

  const nePart2 = cibRowsForNonEmployees(allNonEmployees, "part2");
  assert.deepEqual(nePart2, [], "non-employees never appear on Part 2 — their whole salary pays with Part 1");

  // ---- buildCibSheetWorkbook: exact schema + exact values --------------------
  const buffer = await buildCibSheetWorkbook({
    rows: [{ fullName: "Mahmoud Ibrahim Ahmed Mohamed", bankAccount: "100059597048", salary: 11500 }],
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  assert.deepEqual(workbook.worksheets.map((s) => s.name), ["Sheet1"], "no cover sheet or extra tabs allowed");

  const sheet = workbook.getWorksheet("Sheet1")!;
  const headerRow = sheet.getRow(1);
  const headerValues: string[] = [];
  headerRow.eachCell((cell) => headerValues.push(String(cell.value ?? "")));
  assert.deepEqual(headerValues, [
    "Details_ID",
    "Branch_Code",
    "Employee_Account_No",
    "Currency_Code",
    "Amount",
    "Debit_Credit",
    "Reason_code",
    "Filler",
    "Full_Name",
    "Amount",
  ]);

  const dataRow = sheet.getRow(2);
  assert.equal(dataRow.getCell(1).value, CIB_DETAILS_ID);
  assert.equal(dataRow.getCell(2).value, CIB_BRANCH_CODE);
  assert.equal(dataRow.getCell(3).value, "100059597048", "the account number's leading digits must survive as text");
  assert.equal(dataRow.getCell(4).value, CIB_CURRENCY);
  assert.equal(dataRow.getCell(5).value, "0000001150000");
  assert.equal(dataRow.getCell(6).value, CIB_DEBIT_CREDIT);
  assert.equal(dataRow.getCell(7).value, CIB_REASON_CODE);
  assert.equal(dataRow.getCell(9).value, "MAHMOUD IBRAHIM AHMED MOHAMED", "Full_Name must be uppercased");
  assert.equal(dataRow.getCell(10).value, 11500, "the second Amount column must hold the real, readable number");

  // ---- styling: "same colors same everything" (owner instruction 2026-07-26) -
  const h1 = headerRow.getCell(1);
  assert.equal(h1.font.name, "MS Sans Serif");
  assert.equal(h1.font.bold, true);
  assert.equal((h1.font.color as { argb?: string })?.argb, "FF800000", "header font must be dark red/maroon");
  assert.equal((h1.fill as { fgColor?: { argb?: string } }).fgColor?.argb, "FFFFFF00", "header fill must be pure yellow");
  assert.equal((h1.border.top as { style?: string })?.style, "thick");
  assert.equal((h1.border.bottom as { style?: string })?.style, "thin");
  assert.equal(headerRow.getCell(2).alignment.horizontal, "left", "Branch_Code header is left-aligned in the reference");

  const branchCell = dataRow.getCell(2);
  assert.ok(!branchCell.font.bold, "Branch_Code is the one data column that is NOT bold in the reference");
  assert.equal(branchCell.font.name, "Arial");
  assert.equal(branchCell.font.size, 12);

  const acctCell = dataRow.getCell(3);
  assert.equal(acctCell.font.name, "Calibri");
  assert.equal(acctCell.font.size, 14);
  assert.equal((acctCell.fill as { fgColor?: { argb?: string } }).fgColor?.argb, "FFFFFF00", "account number column must be yellow-highlighted");
  assert.equal((acctCell.border.top as { style?: string })?.style, "hair");
  assert.equal((acctCell.border.bottom as { style?: string })?.style, "hair");

  const amountCell = dataRow.getCell(5);
  assert.equal(amountCell.font.name, "Traditional Arabic");
  assert.equal(amountCell.font.bold, true);
  assert.equal(amountCell.alignment.horizontal, "right");
}
