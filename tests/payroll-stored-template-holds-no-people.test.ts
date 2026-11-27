import assert from "node:assert/strict";
import path from "node:path";

import ExcelJS from "exceljs";

import { buildExactTemplateWorkbook } from "../app/api/payroll/template/route.ts";

// `Phoneix system template.xlsx` sits at the repository root because the payroll template route
// loads it as a LAYOUT, and the plain "download the template" path used to serve its people rows
// exactly as stored. A template must never carry a person. Both halves are pinned here:
//
//   1. the workbook the route builds from it leaves every people row empty, whatever the stored
//      file holds, so a filled copy put back by mistake still never reaches a download;
//   2. the stored file itself holds no person and no pay figure in its people rows (6-126) or its
//      totals row (127) — only the layout, the header labels and the policy notes below.
//
// The download check runs first so each half can be broken on its own: a filled file with the
// route's clearing in place fails only half 2; a filled file without it fails half 1.

const DATA_START = 6;
const DATA_END = 126;
const TOTALS_ROW = 127;
const STORED_FILE = path.join(process.cwd(), "Phoneix system template.xlsx");

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("result" in value) return value.result === undefined || value.result === null ? "" : String(value.result);
    if ("text" in value) return String(value.text);
    if ("formula" in value || "sharedFormula" in value) return "formula";
    return "";
  }
  return String(value);
}

function filledCells(sheet: ExcelJS.Worksheet, fromRow: number, toRow: number, fromColumn = 1) {
  const filled: string[] = [];
  for (let rowNumber = fromRow; rowNumber <= toRow; rowNumber += 1) {
    sheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, column) => {
      if (column >= fromColumn && cellText(cell.value).trim() !== "") filled.push(`R${rowNumber}C${column}`);
    });
  }
  return filled;
}

export async function runPayrollStoredTemplateHoldsNoPeopleTests() {
  // ── 1. the plain-template download leaves every people row empty ────────────
  const built = await buildExactTemplateWorkbook(new Date(Date.UTC(2026, 10, 27, 8, 0, 0)));
  const builtSheet = built.worksheets[0];
  assert.ok(builtSheet, "the plain template must have its upload sheet");

  const builtPeople = filledCells(builtSheet, DATA_START, DATA_END);
  assert.deepEqual(
    builtPeople.slice(0, 10),
    [],
    `the plain template download carries ${builtPeople.length} filled cells in its people rows; ` +
      "it must carry none, whatever the stored file holds",
  );

  // ── 2. the stored file is a layout, never a payroll ─────────────────────────
  const stored = new ExcelJS.Workbook();
  await stored.xlsx.readFile(STORED_FILE);
  const storedSheet = stored.worksheets[0];
  assert.ok(storedSheet, "the stored payroll template must have its sheet");

  assert.equal(
    cellText(storedSheet.getRow(DATA_START - 1).getCell(3).value).trim(),
    "Employee Name",
    "row 5 stays the header row, so the people rows are 6 onward",
  );

  const storedPeople = filledCells(storedSheet, DATA_START, DATA_END);
  assert.deepEqual(
    storedPeople.slice(0, 10),
    [],
    `the stored payroll template holds ${storedPeople.length} filled cells in its people rows ` +
      `(${DATA_START}-${DATA_END}); it must hold none — a template is a layout, never a payroll`,
  );

  const storedTotals = filledCells(storedSheet, TOTALS_ROW, TOTALS_ROW, 3);
  assert.deepEqual(
    storedTotals,
    [],
    "the stored totals row keeps its label and no figure — a total of real pay is still real pay",
  );

  // No HR id anywhere in the sheet: the letter-dash-number shape is what every employee row carries.
  const hrIds: string[] = [];
  storedSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, column) => {
      if (/^[A-Z]-\d{1,4}$/.test(cellText(cell.value).trim())) hrIds.push(`R${rowNumber}C${column}`);
    });
  });
  assert.deepEqual(hrIds, [], "the stored payroll template names no employee by HR id");
}
