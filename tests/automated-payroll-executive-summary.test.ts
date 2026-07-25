import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import type { AssembledRow } from "../src/lib/automated-payroll/assemble.ts";
import { buildFullSheetWorkbook, buildPart1SheetWorkbook } from "../src/lib/automated-payroll/exports/sheet.ts";
import { isAtOrBeforeLaunch } from "../src/lib/automated-payroll/run-service.ts";
import type { MonthlySalaryRun } from "../src/lib/automated-payroll/types.ts";

/**
 * Guards the Executive Summary Dashboard (owner request 2026-07-25: "must have
 * comparison between the last month in number of employees and value of
 * money") appended to both the Part 1 and Full downloaded xlsx sheets.
 */
export async function runAutomatedPayrollExecutiveSummaryTests() {
  // ---- owner follow-up (2026-07-25): "treat july as a fresh [start],
  // starting from august compare" — July 2026 (and anything earlier) must
  // NEVER show a month-over-month comparison, regardless of what data exists.
  assert.equal(isAtOrBeforeLaunch({ month: 7, year: 2026 }), true, "the launch month itself is at-or-before launch");
  assert.equal(isAtOrBeforeLaunch({ month: 6, year: 2026 }), true, "a month before launch is at-or-before launch");
  assert.equal(isAtOrBeforeLaunch({ month: 1, year: 2025 }), true, "an earlier year is at-or-before launch");
  assert.equal(isAtOrBeforeLaunch({ month: 8, year: 2026 }), false, "August is the first month comparisons begin");
  assert.equal(isAtOrBeforeLaunch({ month: 1, year: 2027 }), false, "a later year is after launch");

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

  const fakeRow = (firstPart: number, monthSalary: number): AssembledRow =>
    ({
      row: { firstPart, monthSalary } as AssembledRow["row"],
      compact: `hr-${firstPart}`,
      onHold: false,
      overpaidResidual: 0,
      lifecycle: "regular",
      bankName: null,
      bankAccount: null,
    }) as AssembledRow;

  async function readAllText(buffer: Buffer, sheetName: string): Promise<string[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.getWorksheet(sheetName);
    assert.ok(sheet, `${sheetName} sheet must exist`);
    const text: string[] = [];
    sheet!.eachRow((r) => r.eachCell((cell) => text.push(String(cell.value ?? ""))));
    return text;
  }

  // ---- Part 1 sheet: 2 employees this month, 3 + lower total last month -----
  const rows = [fakeRow(10000, 12000), fakeRow(8000, 9000)];
  const withPrevious = await buildPart1SheetWorkbook({
    run,
    rows,
    previousSummary: { headcount: 3, totalValue: 15000 },
  });
  const text = await readAllText(withPrevious, "Executive Summary");
  assert.ok(text.includes("Employees"));
  assert.ok(text.includes("Total First Part"));
  assert.ok(text.includes("2"), "current headcount (2) must appear");
  assert.ok(text.includes("3"), "previous headcount (3) must appear");
  // This month total First Part = 18000; previous = 15000 -> delta +3000, +20%.
  assert.ok(text.includes("18000"));
  assert.ok(text.includes("15000"));
  assert.ok(text.includes("3000"));
  assert.ok(text.some((t) => t.includes("+20%")), "percent change must be computed and signed");

  // ---- no previous month (first-ever run) -> sheet still renders, no crash,
  // comparison columns show a placeholder instead of a false zero ------------
  const withoutPrevious = await buildPart1SheetWorkbook({ run, rows, previousSummary: null });
  const textNoPrev = await readAllText(withoutPrevious, "Executive Summary");
  assert.ok(textNoPrev.includes("Employees"));
  assert.equal(
    textNoPrev.filter((t) => t === "—").length,
    6,
    "Last Month / Change / % Change must show a placeholder for both metrics (3 cols x 2 metrics), not a misleading 0",
  );

  // ---- Full sheet variant: labels "Total Month Salary", not "Total First Part" -
  const fullBuffer = await buildFullSheetWorkbook({
    run,
    rows,
    previousSummary: { headcount: 2, totalValue: 21000 },
  });
  const fullText = await readAllText(fullBuffer, "Executive Summary");
  assert.ok(fullText.includes("Total Month Salary"));
  assert.ok(!fullText.includes("Total First Part"), "the Full sheet must compare Month Salary, not First Part");
  // Current Month Salary total = 12000 + 9000 = 21000; previous = 21000 -> no change.
  assert.ok(fullText.some((t) => t.includes("0%")) || fullText.includes("0"));
}
