import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { buildFullSheetWorkbook, buildPart1SheetWorkbook } from "../src/lib/automated-payroll/exports/sheet.ts";
import { sumNonEmployeePayroll } from "../src/lib/automated-payroll/non-employees.ts";
import type { MonthlySalaryRun, NonEmployeePayrollRow } from "../src/lib/automated-payroll/types.ts";

/**
 * Guards Non-Employees Payroll (owner rules 2026-07-25 + 2026-07-26): people
 * paid a monthly salary with no employee/HR_ID record. As of 2026-07-26 they
 * are rendered as ADDITIONAL ROWS in the SAME table as real employees — under
 * the normal "Full Name"/"Bank Name"/"Bank Account" headers and whichever
 * money column the sheet pays out (First Part / Month Salary) — not a
 * separate section. They still never touch AssembledRow/DraftRow/
 * publishToPayslips (see [[automated-payroll-special-situations-tab]] for the
 * sibling Special Situations feature this was built alongside).
 */

type SheetRow = { header: string; value: ExcelJS.CellValue }[];

async function readSheetRows(buffer: Buffer, sheetName: string): Promise<SheetRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet(sheetName);
  assert.ok(sheet, `${sheetName} sheet must exist`);
  // Header row is the first row carrying "Full Name" (row 5 per bandHeader's brand band).
  let headerRowNumber = -1;
  let headers: string[] = [];
  sheet!.eachRow((row, rowNumber) => {
    if (headerRowNumber >= 0) return;
    const texts = Array.from(row.values as unknown[]);
    if (texts.some((v) => v === "Full Name")) {
      headerRowNumber = rowNumber;
      headers = texts.map((v) => String(v ?? ""));
    }
  });
  assert.ok(headerRowNumber > 0, "a header row containing Full Name must exist");

  const rows: SheetRow[] = [];
  sheet!.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    const values = Array.from(row.values as unknown[]);
    const entry: SheetRow = headers.map((header, index) => ({ header, value: values[index] as ExcelJS.CellValue }));
    rows.push(entry);
  });
  return rows;
}

function cellFor(row: SheetRow, header: string): ExcelJS.CellValue {
  const found = row.find((c) => c.header === header);
  return found?.value ?? "";
}

/** Reads the "This Month" figure for one metric row off the Executive Summary tab. */
async function readExecutiveSummaryValue(buffer: Buffer, metricLabel: string): Promise<ExcelJS.CellValue> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("Executive Summary");
  assert.ok(sheet, "Executive Summary sheet must exist");
  let value: ExcelJS.CellValue = null;
  sheet!.eachRow((row) => {
    if (row.getCell(1).value === metricLabel) value = row.getCell(2).value;
  });
  return value;
}

export async function runAutomatedPayrollNonEmployeesTests() {
  // ---- sumNonEmployeePayroll: sums and rounds to 2 decimals ------------------
  const row = (totalSalary: number): NonEmployeePayrollRow => ({
    id: "id",
    runId: "run",
    part: "first",
    fullNameAr: "اسم",
    fullNameEn: "Name",
    totalSalary,
    bankName: null,
    bankAccount: null,
    recurringId: null,
    createdBy: null,
    createdAt: "",
    updatedAt: "",
  });
  assert.equal(sumNonEmployeePayroll([]), 0);
  assert.equal(sumNonEmployeePayroll([row(1000), row(2500.555)]), 3500.56);

  // ---- Part 1 sheet: non-employees become regular rows under the normal
  // headers, even with ZERO real employees on the run --------------------------
  const run: MonthlySalaryRun = {
    id: "run-1",
    month: 7,
    year: 2026,
    monthKey: "2026-07",
    phase: "part1",
    part1ConfirmedAt: null,
    part1ConfirmedBy: null,
    part2ConfirmedAt: null,
    part2ConfirmedBy: null,
    publishedBatchId: null,
    publishedAt: null,
    publishedBy: null,
    createdBy: null,
    createdAt: "",
    updatedAt: "",
  };
  const nonEmployees: NonEmployeePayrollRow[] = [
    row(1000),
    { ...row(2000), fullNameEn: "Second Person", fullNameAr: "شخص ثانٍ", bankName: "NBE", bankAccount: "123" },
  ];

  const buffer = await buildPart1SheetWorkbook({ run, rows: [], nonEmployees });
  const part1Rows = await readSheetRows(buffer, "Part 1");

  // No separate "Non-Employees Payroll" caption or GRAND TOTAL row anymore.
  const flatValues = part1Rows.flatMap((r) => r.map((c) => String(c.value ?? "")));
  assert.ok(
    !flatValues.some((v) => v.includes("Non-Employees Payroll") || v.includes("GRAND TOTAL")),
    "there must be no separate Non-Employees section left in the sheet",
  );

  const secondPersonRow = part1Rows.find((r) => cellFor(r, "Full Name") === "Second Person");
  assert.ok(secondPersonRow, "each non-employee must appear as a normal row under Full Name");
  assert.equal(cellFor(secondPersonRow!, "First Part"), 2000, "their amount must land under First Part");
  assert.equal(cellFor(secondPersonRow!, "Bank Name"), "NBE", "bank details land under the normal Bank Name column");
  assert.equal(cellFor(secondPersonRow!, "Bank Account"), "123");
  assert.equal(cellFor(secondPersonRow!, "HR_ID"), "", "no HR_ID exists for a non-employee — left blank, not faked");

  const firstPersonRow = part1Rows.find((r) => cellFor(r, "Full Name") === "Name");
  assert.ok(firstPersonRow, "the first non-employee (no bank on file) must also appear as a row");
  assert.equal(cellFor(firstPersonRow!, "First Part"), 1000);
  assert.equal(cellFor(firstPersonRow!, "Bank Name"), "", "no bank on file renders blank, not null/undefined text");

  // TOTALS row: 0 real employees + 1000 + 2000 non-employees = 3000.
  const totalsRow = part1Rows.find((r) => cellFor(r, "#") === "TOTALS");
  assert.ok(totalsRow, "a TOTALS row must exist");
  assert.equal(cellFor(totalsRow!, "First Part"), 3000, "TOTALS must fold in the non-employees' contribution");

  // Executive Summary must be accurate too — its "Total First Part" figure must
  // match the main sheet's TOTALS row exactly, non-employees included (owner
  // rule 2026-07-26: it must be accurate even when non-employees exist).
  assert.equal(
    await readExecutiveSummaryValue(buffer, "Total First Part"),
    3000,
    "Executive Summary total must fold in the non-employees' contribution, matching the TOTALS row",
  );

  // ---- the FULL monthly sheet must include them too (owner decision
  // 2026-07-25), landing under Month Salary instead of First Part --------------
  const fullBuffer = await buildFullSheetWorkbook({ run, rows: [], nonEmployees });
  const fullRows = await readSheetRows(fullBuffer, "Payroll");
  const fullSecondPerson = fullRows.find((r) => cellFor(r, "Full Name") === "Second Person");
  assert.ok(fullSecondPerson, "each non-employee must be listed on the Full sheet too");
  assert.equal(cellFor(fullSecondPerson!, "Month Salary"), 2000, "on the Full sheet the amount lands under Month Salary");
  const fullTotalsRow = fullRows.find((r) => cellFor(r, "#") === "TOTALS");
  assert.ok(fullTotalsRow, "a TOTALS row must exist on the Full sheet");
  assert.equal(cellFor(fullTotalsRow!, "Month Salary"), 3000);
  assert.equal(
    await readExecutiveSummaryValue(fullBuffer, "Total Month Salary"),
    3000,
    "Full sheet's Executive Summary total must also fold in the non-employees' contribution",
  );

  // ---- a PART 2 non-employee must be visible AS Part 2, and the TOTALS row
  // must still foot (owner-reported 2026-08-08: "the non-employee payroll Part 2
  // is not showing in the downloaded xlsx").
  //
  // The full sheet used to write EVERY non-employee into "Month Salary" alone,
  // leaving First Part and Second Part blank for them. So a Part 2 non-employee
  // was indistinguishable from a Part 1 one — the same person paid in both
  // installments rendered as two identical-looking rows — and the TOTALS row
  // stopped balancing. Measured on the live July 2026 run before the fix:
  // Month Salary exceeded First Part + Second Part by exactly 381,535.00, the
  // whole non-employee payroll, with nothing on the sheet saying which
  // installment pays it.
  const bothParts: NonEmployeePayrollRow[] = [
    { ...row(1000), fullNameEn: "Part One Person" },
    { ...row(400), fullNameEn: "Part Two Person", part: "second" },
  ];
  const bothBuffer = await buildFullSheetWorkbook({ run, rows: [], nonEmployees: bothParts });
  const bothRows = await readSheetRows(bothBuffer, "Payroll");

  const partTwoRow = bothRows.find((r) => cellFor(r, "Full Name") === "Part Two Person");
  assert.ok(partTwoRow, "a Part 2 non-employee must appear on the full sheet");
  assert.equal(
    cellFor(partTwoRow!, "Second Part"),
    400,
    "a Part 2 non-employee's amount must land in the Second Part column — otherwise their money is invisible as Part 2",
  );
  assert.equal(cellFor(partTwoRow!, "First Part"), "", "a Part 2 non-employee must NOT be counted in the first installment");
  assert.equal(cellFor(partTwoRow!, "Month Salary"), 400, "their amount still totals into the month's whole picture");
  assert.equal(
    cellFor(partTwoRow!, "Payment Group"),
    "Non-Employee · Part 2",
    "the row must say which installment it belongs to, so the same person paid twice never reads as a duplicate",
  );

  const partOneRow = bothRows.find((r) => cellFor(r, "Full Name") === "Part One Person");
  assert.ok(partOneRow, "a Part 1 non-employee must appear on the full sheet");
  assert.equal(cellFor(partOneRow!, "First Part"), 1000, "a Part 1 non-employee's amount lands in the First Part column");
  assert.equal(cellFor(partOneRow!, "Second Part"), "", "a Part 1 non-employee must NOT be counted in the second installment");
  assert.equal(cellFor(partOneRow!, "Payment Group"), "Non-Employee · Part 1");

  // THE INVARIANT THAT BROKE: First Part + Second Part must equal Month Salary
  // on the TOTALS row, non-employees included.
  const bothTotals = bothRows.find((r) => cellFor(r, "#") === "TOTALS");
  assert.ok(bothTotals, "a TOTALS row must exist");
  const totalFirst = Number(cellFor(bothTotals!, "First Part")) || 0;
  const totalSecond = Number(cellFor(bothTotals!, "Second Part")) || 0;
  const totalMonth = Number(cellFor(bothTotals!, "Month Salary")) || 0;
  assert.equal(totalFirst, 1000, "TOTALS First Part must fold in only the Part 1 non-employees");
  assert.equal(totalSecond, 400, "TOTALS Second Part must fold in only the Part 2 non-employees");
  assert.equal(totalMonth, 1400, "TOTALS Month Salary must fold in every non-employee");
  assert.equal(
    Math.round((totalFirst + totalSecond) * 100) / 100,
    totalMonth,
    "the TOTALS row must balance: First Part + Second Part = Month Salary, non-employees included",
  );

  // ---- no non-employees this run -> no extra rows, no stray section ----------
  const emptyBuffer = await buildPart1SheetWorkbook({ run, rows: [], nonEmployees: [] });
  const emptyRows = await readSheetRows(emptyBuffer, "Part 1");
  const emptyFlat = emptyRows.flatMap((r) => r.map((c) => String(c.value ?? "")));
  assert.ok(!emptyFlat.includes("Second Person"), "no non-employee rows should be written when the run has none");
  const emptyTotalsRow = emptyRows.find((r) => cellFor(r, "#") === "TOTALS");
  assert.equal(cellFor(emptyTotalsRow!, "First Part"), 0);
}
