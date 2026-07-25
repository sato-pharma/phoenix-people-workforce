import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { buildPart1SheetWorkbook } from "../src/lib/automated-payroll/exports/sheet.ts";
import { sumNonEmployeePayroll } from "../src/lib/automated-payroll/non-employees.ts";
import type { MonthlySalaryRun, NonEmployeePayrollRow } from "../src/lib/automated-payroll/types.ts";

/**
 * Guards Non-Employees Payroll (owner rule 2026-07-25): people paid a monthly
 * salary with no employee/HR_ID record, appended to the Part 1 xlsx sheet's own
 * section + grand total — deliberately never touching AssembledRow/DraftRow/
 * publishToPayslips (see [[automated-payroll-special-situations-tab]] for the
 * sibling Special Situations feature this was built alongside).
 */
export async function runAutomatedPayrollNonEmployeesTests() {
  // ---- sumNonEmployeePayroll: sums and rounds to 2 decimals ------------------
  const row = (totalSalary: number): NonEmployeePayrollRow => ({
    id: "id",
    runId: "run",
    fullNameAr: "اسم",
    fullNameEn: "Name",
    totalSalary,
    bankName: null,
    bankAccount: null,
    createdBy: null,
    createdAt: "",
    updatedAt: "",
  });
  assert.equal(sumNonEmployeePayroll([]), 0);
  assert.equal(sumNonEmployeePayroll([row(1000), row(2500.555)]), 3500.56);

  // ---- the Part 1 xlsx sheet appends a Non-Employees section + grand total,
  // even with ZERO real employees on the run (no AssembledRow fixture needed —
  // the section must stand on its own) -----------------------------------------
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
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("Part 1");
  assert.ok(sheet, "Part 1 sheet must exist");

  const allText: string[] = [];
  sheet!.eachRow((r) => r.eachCell((cell) => allText.push(String(cell.value ?? ""))));
  assert.ok(
    allText.some((text) => text.includes("Non-Employees Payroll")),
    "the Non-Employees section caption must appear in the exported sheet",
  );
  assert.ok(allText.includes("Second Person"), "each non-employee row must be written");
  assert.ok(allText.includes("NBE"), "bank details must be written when present");

  // 0 real employees (First Part total = 0) + 3000 non-employee subtotal. The
  // caption and its value are the only two cells written on that row, so they
  // are adjacent in the flattened per-row cell order regardless of column gaps.
  const grandTotalCellIndex = allText.indexOf("GRAND TOTAL (Employees First Part + Non-Employees)");
  assert.ok(grandTotalCellIndex >= 0, "a GRAND TOTAL row must exist");
  assert.equal(Number(allText[grandTotalCellIndex + 1]), 3000);

  // ---- no non-employees this run -> the section is a clean no-op, no stray
  // caption/header rows left behind -------------------------------------------
  const emptyBuffer = await buildPart1SheetWorkbook({ run, rows: [], nonEmployees: [] });
  const emptyWorkbook = new ExcelJS.Workbook();
  await emptyWorkbook.xlsx.load(emptyBuffer as unknown as Parameters<typeof emptyWorkbook.xlsx.load>[0]);
  const emptySheet = emptyWorkbook.getWorksheet("Part 1");
  const emptyText: string[] = [];
  emptySheet!.eachRow((r) => r.eachCell((cell) => emptyText.push(String(cell.value ?? ""))));
  assert.ok(
    !emptyText.some((text) => text.includes("Non-Employees Payroll")),
    "no Non-Employees section should be written when the run has none",
  );
}
