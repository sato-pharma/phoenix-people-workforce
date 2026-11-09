import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import type { AssembledRow } from "../src/lib/automated-payroll/assemble.ts";
import { HELD_RELEASE_ONLY_COMMENT } from "../src/lib/payroll/held-release.ts";
import { buildFinanceSheetWorkbook } from "../src/lib/automated-payroll/exports/finance-sheet.ts";
import {
  buildFullSheetWorkbook,
  buildPart1SheetWorkbook,
  NAME_HIGHLIGHT,
  NON_EMPLOYEES_SEPARATOR_LABEL,
  TWO_PARTS_SEPARATOR_LABEL,
} from "../src/lib/automated-payroll/exports/sheet.ts";
import type { MonthlySalaryRun, NonEmployeePayrollRow } from "../src/lib/automated-payroll/types.ts";

// Owner rule, 2026-10-26: "when I export the automated payroll sheet make sure that the one pay mode
// are always at the top, then a clear separator separates them from those of 2 pay modes."
//
// The fixed HR-ID execution order (export-order.ts) still decides the order INSIDE each group — it
// interleaved the two pay modes before, so a One Part employee could sit anywhere in the table.

const run: MonthlySalaryRun = {
  createdAt: "", createdBy: null, id: "run-1", month: 9, monthKey: "2026-09",
  part1ConfirmedAt: null, part1ConfirmedBy: null, part2ConfirmedAt: null, part2ConfirmedBy: null,
  phase: "part1", publishedAt: null, publishedBatchId: null, publishedBy: null,
  updatedAt: "", year: 2026,
};

function assembled(
  hrId: string,
  paymentMode: "one_part" | "two_parts",
  lifecycle: "regular" | "joiner" | "leaver" = "regular",
): AssembledRow {
  return {
    bankAccount: "EG1", bankName: "CIB", carriedForwardApplied: 0, compact: hrId.toLowerCase(),
    lifecycle, onHold: false, overpaidResidual: 0,
    row: {
      area: "Cairo", baseSalary: 12000, bonus: 0, calendarDays: 30, crm: 0, employmentIncomeTax: 640,
      expenses: 0, extraCostOfLiving: 500, fingerPrint: 0, firstPart: 6000, fuelAllowance: 800,
      fullName: `Person ${hrId}`, governmentalDeductions: 1140, grossSalary: 13140, hireDate: "2022-06-01",
      hrId, incentive: 0, jobTitle: "Medical Rep", line: "CNS", loans: 0, medicalInsurance: 0,
      monthSalary: 12000, nameAr: null, netSalary: 13300, otherAdditions: 0, otherDeductions: 0,
      overtime: 0, paymentMode, payrollComment: null, row: 1,
      secondPart: paymentMode === "one_part" ? 0 : 6000,
      socialInsurance: 500, totalAdditions: 1300, totalDeductions: 1140, unpaidVacations: 0,
      workingDays: 26,
    },
  } as AssembledRow;
}

const nonEmployee: NonEmployeePayrollRow = {
  bankAccount: null, bankName: null, createdAt: "", createdBy: null, fullNameAr: "", fullNameEn: "Outside Person",
  id: "ne-1", part: "first", recurringId: null, runId: "run-1", totalSalary: 1000, updatedAt: "",
};

async function load(buffer: ArrayBuffer | Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

/** Every body row under the header (row 5), as "HR_ID" or the separator's words, up to TOTALS. */
function bodyLines(sheet: ExcelJS.Worksheet): string[] {
  const header = sheet.getRow(5).values as unknown[];
  const hrColumn = header.indexOf("HR_ID");
  const nameColumn = header.indexOf("Full Name");
  const lines: string[] = [];
  for (let rowNumber = 6; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const first = String(row.getCell(1).value ?? "");
    if (first === "TOTALS") break;
    if (first === TWO_PARTS_SEPARATOR_LABEL || first === NON_EMPLOYEES_SEPARATOR_LABEL) lines.push(first);
    else lines.push(String(row.getCell(hrColumn).value ?? "") || String(row.getCell(nameColumn).value ?? ""));
  }
  return lines;
}

export async function runAutomatedPayrollPayModeOrderTests() {
  // In the fixed export order A-1, A-2, A-9, A-3 — so before this rule the two modes interleaved.
  const mixed = [
    assembled("A-1", "two_parts"),
    assembled("A-2", "one_part"),
    assembled("A-9", "two_parts"),
    assembled("A-3", "one_part"),
  ];

  const variants: Array<[string, string, Buffer]> = [
    ["full", "Payroll", (await buildFullSheetWorkbook({ run, rows: mixed, nonEmployees: [nonEmployee] })) as Buffer],
    ["part1", "Part 1", (await buildPart1SheetWorkbook({ run, rows: mixed, nonEmployees: [nonEmployee] })) as Buffer],
    [
      "finance",
      "Part 1 (Finance)",
      (await buildFinanceSheetWorkbook({ run, rows: mixed, scope: "part1", nonEmployees: [nonEmployee] })) as Buffer,
    ],
  ];

  for (const [variant, sheetName, buffer] of variants) {
    const sheet = (await load(buffer)).getWorksheet(sheetName);
    assert.ok(sheet, `${variant}: the ${sheetName} sheet must exist`);
    assert.deepEqual(
      bodyLines(sheet!),
      ["A-2", "A-3", TWO_PARTS_SEPARATOR_LABEL, "A-1", "A-9", NON_EMPLOYEES_SEPARATOR_LABEL, "Outside Person"],
      `${variant}: One Part employees first (fixed order kept inside), the separator, then Two Parts, ` +
        "then the non-employees under their own band",
    );

    const totals = Array.from({ length: sheet!.rowCount }, (_, i) => sheet!.getRow(i + 1)).find(
      (row) => row.getCell(1).value === "TOTALS",
    );
    const header = sheet!.getRow(5).values as unknown[];
    assert.equal(
      totals!.getCell(header.indexOf("First Part")).value,
      4 * 6000 + 1000,
      `${variant}: the separator rows add nothing to the TOTALS`,
    );
  }

  // Owner rule, 2026-10-26: only the Full Name cell is tinted — One Part, Two Parts, New hire,
  // Resignation — and a new hire or a resignation outranks the pay mode.
  const tinted = [
    assembled("A-1", "two_parts"),
    assembled("A-2", "one_part"),
    assembled("A-9", "two_parts", "joiner"),
    assembled("A-3", "one_part", "leaver"),
    // Owner, 2026-11-09: a row that only pays an earlier month's held salary is coloured as a resignation.
    { ...assembled("A-7", "two_parts"), row: { ...assembled("A-7", "two_parts").row, payrollComment: HELD_RELEASE_ONLY_COMMENT, workingDays: 0 } },
  ];
  for (const [variant, sheetName, buffer] of [
    ["full", "Payroll", (await buildFullSheetWorkbook({ run, rows: tinted })) as Buffer],
    ["finance", "Part 1 (Finance)", (await buildFinanceSheetWorkbook({ run, rows: tinted, scope: "part1" })) as Buffer],
  ] as Array<[string, string, Buffer]>) {
    const sheet = (await load(buffer)).getWorksheet(sheetName)!;
    const header = sheet.getRow(5).values as unknown[];
    const hrColumn = header.indexOf("HR_ID");
    const nameColumn = header.indexOf("Full Name");
    const fillOf = (cell: ExcelJS.Cell) => (cell.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;
    const byHrId = new Map<string, ExcelJS.Row>();
    for (let rowNumber = 6; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const hrId = String(row.getCell(hrColumn).value ?? "");
      if (hrId) byHrId.set(hrId, row);
    }
    const expected: Record<string, string> = {
      "A-2": NAME_HIGHLIGHT.one_part.argb,
      "A-1": NAME_HIGHLIGHT.two_parts.argb,
      "A-9": NAME_HIGHLIGHT.joiner.argb,
      "A-3": NAME_HIGHLIGHT.leaver.argb,
      "A-7": NAME_HIGHLIGHT.leaver.argb,
    };
    for (const [hrId, argb] of Object.entries(expected)) {
      const row = byHrId.get(hrId)!;
      assert.equal(fillOf(row.getCell(nameColumn)), argb, `${variant}: ${hrId}'s name carries its highlight`);
      assert.notEqual(fillOf(row.getCell(hrColumn)), argb, `${variant}: ${hrId} — only the name is highlighted`);
    }
    const key = [1, 2, 3, 4].map((offset) => sheet.getRow(4).getCell(nameColumn + offset - 1));
    assert.deepEqual(
      key.map((cell) => [cell.value, fillOf(cell)]),
      Object.values(NAME_HIGHLIGHT).map((entry) => [entry.label, entry.argb]),
      `${variant}: the colour key sits above the table`,
    );
  }

  // One group only → no separator at all, the sheet reads exactly as it did.
  const allTwo = await load(
    (await buildFullSheetWorkbook({ run, rows: [assembled("A-1", "two_parts"), assembled("A-2", "two_parts")] })) as Buffer,
  );
  assert.deepEqual(bodyLines(allTwo.getWorksheet("Payroll")!), ["A-1", "A-2"], "one pay mode only: no separator");
}
