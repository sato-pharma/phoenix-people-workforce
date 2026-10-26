import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import type { AssembledRow } from "../src/lib/automated-payroll/assemble.ts";
import {
  buildFabSheetWorkbook,
  defaultFabValueDate,
  FAB_BANK_LABEL,
  FAB_COMPANY_ACCOUNT_NUMBER,
  FAB_CURRENCY,
  FAB_TITLE,
  FAB_TRNS_DESC,
  fabRowsForNonEmployees,
  fabRowsForScope,
} from "../src/lib/automated-payroll/exports/fab-sheet.ts";
import type { NonEmployeePart, NonEmployeePayrollRow } from "../src/lib/automated-payroll/types.ts";
import type { SalaryValidationRow } from "../src/lib/payroll/salary-import.ts";

/**
 * Guards the FAB (First Abu Dhabi Bank) bulk salary-transfer sheet — a literal
 * bank-execution artifact verified cell-by-cell against the company's real
 * May 2026 submission (see exports/fab-sheet.ts doc comment). Every constant
 * pinned here is a value the bank has actually accepted; changing one without
 * re-verifying against a real accepted file is exactly the kind of silent
 * drift this test exists to catch.
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
    bankName: overrides.bankName === undefined ? "FAB" : overrides.bankName,
    bankAccount: overrides.bankAccount === undefined ? "009999990001" : overrides.bankAccount,
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
    bankName: overrides.bankName === undefined ? "FAB" : overrides.bankName,
    bankAccount: overrides.bankAccount === undefined ? "007111110001" : overrides.bankAccount,
    recurringId: null,
    createdBy: null,
    createdAt: "",
    updatedAt: "",
  };
}

async function readCells(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("Sheet1");
  assert.ok(sheet, "the FAB workbook must contain a sheet literally named Sheet1");
  const rows: string[][] = [];
  sheet!.eachRow((r) => {
    const cells: string[] = [];
    r.eachCell({ includeEmpty: true }, (cell) => cells.push(String(cell.value ?? "")));
    rows.push(cells);
  });
  return rows;
}

export async function runAutomatedPayrollFabSheetTests() {
  // ---- constants pinned to the real, bank-accepted reference file ------------
  assert.equal(FAB_COMPANY_ACCOUNT_NUMBER, "00716838");
  assert.equal(FAB_BANK_LABEL, "FABMISR");
  assert.equal(FAB_TITLE, "Mr.");
  assert.equal(FAB_CURRENCY, "EGP");
  assert.equal(FAB_TRNS_DESC, "Salary");

  // ---- defaultFabValueDate: the 25th of the run's month, UTC-safe -----------
  const julyDate = defaultFabValueDate({ month: 7, year: 2026 });
  assert.equal(julyDate.getUTCFullYear(), 2026);
  assert.equal(julyDate.getUTCMonth(), 6); // 0-indexed
  assert.equal(julyDate.getUTCDate(), 25);
  const januaryDate = defaultFabValueDate({ month: 1, year: 2027 });
  assert.equal(januaryDate.getUTCMonth(), 0);
  assert.equal(januaryDate.getUTCDate(), 25);

  // ---- fabRowsForScope: filtering rules --------------------------------------
  const heldRow = buildAssembledRow({ hrId: "B-2", onHold: true, firstPart: 9000, secondPart: 9000 });
  const nonFabRow = buildAssembledRow({ hrId: "B-3", bankName: "CIB", firstPart: 9000, secondPart: 9000 });
  const nullBankRow = buildAssembledRow({ hrId: "B-4", bankName: null, firstPart: 9000, secondPart: 9000 });
  const noAccountRow = buildAssembledRow({ hrId: "B-5", bankAccount: "", firstPart: 9000, secondPart: 9000 });
  const zeroSecondPartRow = buildAssembledRow({ hrId: "B-6", firstPart: 15000, secondPart: 0 });
  const lowercaseFabRow = buildAssembledRow({ hrId: "B-7", bankName: "fab", firstPart: 4000, secondPart: 4000 });
  const normalRow = buildAssembledRow({ hrId: "B-8", fullName: "Amany Wasiem", firstPart: 5500, secondPart: 6200 });

  const allRows = [heldRow, nonFabRow, nullBankRow, noAccountRow, zeroSecondPartRow, lowercaseFabRow, normalRow];

  const part1Rows = fabRowsForScope(allRows, "part1");
  assert.equal(part1Rows.length, 3, "held / non-FAB / no-account rows must be excluded from Part 1 too");
  const part1HrNames = part1Rows.map((r) => r.fullName);
  assert.ok(part1HrNames.includes("Jane Doe")); // lowercaseFabRow's default fullName
  assert.ok(part1HrNames.includes("Amany Wasiem"));
  const zeroInPart1 = part1Rows.find((r) => r.salary === 15000);
  assert.ok(zeroInPart1, "a row with Part-1 amount > 0 stays in Part 1 even if its Part-2 amount is 0");

  const part2Rows = fabRowsForScope(allRows, "part2");
  assert.equal(
    part2Rows.some((r) => r.salary === 0),
    false,
    "zero-amount rows must never appear in the sheet, including a fully-settled-in-Part-1 leaver",
  );
  assert.equal(part2Rows.length, 2, "only lowercaseFabRow and normalRow have a nonzero Part-2 amount");

  // ---- fabRowsForNonEmployees: a completely separate data source from
  // AssembledRow (owner-reported 2026-07-26: they were silently missing from
  // the real bank file because fabRowsForScope never sees them at all) --------
  const neNormal = buildNonEmployeeRow({ fullNameEn: "Freelance Person" });
  const neNonFab = buildNonEmployeeRow({ bankName: "CIB" });
  const neNullBank = buildNonEmployeeRow({ bankName: null });
  const neNoAccount = buildNonEmployeeRow({ bankAccount: "" });
  const neZeroSalary = buildNonEmployeeRow({ totalSalary: 0 });
  const neLowercase = buildNonEmployeeRow({ fullNameEn: "Lowercase Bank Person", bankName: "fab" });
  const allNonEmployees = [neNormal, neNonFab, neNullBank, neNoAccount, neZeroSalary, neLowercase];

  const nePart1 = fabRowsForNonEmployees(allNonEmployees, "part1");
  assert.equal(nePart1.length, 2, "only the two real FAB-bank, nonzero, has-account rows survive");
  assert.ok(nePart1.some((r) => r.fullName === "Freelance Person"));
  assert.ok(nePart1.some((r) => r.fullName === "Lowercase Bank Person"));
  assert.equal(nePart1.find((r) => r.fullName === "Freelance Person")?.salary, 3000);

  const nePart2 = fabRowsForNonEmployees(allNonEmployees, "part2");
  assert.deepEqual(nePart2, [], "non-employees never appear on Part 2 — their whole salary pays with Part 1");

  // ---- buildFabSheetWorkbook: exact schema, exact constants, exact values ----
  const buffer = await buildFabSheetWorkbook({
    rows: [{ fullName: "Amany Wasiem Gamel Soliman", bankAccount: "009302940001", salary: 9800 }],
    valueDate: new Date(Date.UTC(2026, 6, 25)),
  });
  const cells = await readCells(buffer);
  assert.deepEqual(cells[0], [
    "COMPANY ACCOUNT NUMBER",
    "Title",
    "Full_Name",
    "Salary",
    "Currency",
    "Employee Account_Number",
    "Bank_Name",
    "Value Date",
    "Trns_Desc",
  ]);
  const [companyAccount, title, fullName, salary, currency, employeeAccount, bankLabel, , trnsDesc] = cells[1];
  assert.equal(companyAccount, FAB_COMPANY_ACCOUNT_NUMBER);
  assert.equal(title, FAB_TITLE);
  assert.equal(fullName, "AMANY WASIEM GAMEL SOLIMAN", "Full_Name must be uppercased");
  assert.equal(Number(salary), 9800);
  assert.equal(currency, FAB_CURRENCY);
  assert.equal(employeeAccount, "009302940001", "the account number's leading zeros must survive");
  assert.equal(bankLabel, FAB_BANK_LABEL);
  assert.equal(trnsDesc, FAB_TRNS_DESC);

  // ---- no third-party additions: exactly 9 columns, no cover sheet -----------
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  assert.deepEqual(workbook.worksheets.map((s) => s.name), ["Sheet1"], "no cover sheet or extra tabs allowed");
  assert.equal(cells[0].length, 9, "exactly 9 columns — no extra columns of any kind");
}
