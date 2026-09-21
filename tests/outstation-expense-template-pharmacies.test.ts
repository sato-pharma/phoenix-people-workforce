import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { analyzeExpenseWorkbook, type EmployeeLookupMaps } from "../src/lib/outstation/expense-import.ts";

/**
 * The Excel expense template carries the third workload figure, AM · PM · Pharmacies, both ways.
 *
 * THE GAP. The 2026-09-21 split gave every trip a `pharmacy_workload`, but the downloaded template
 * stopped at "PM Workload" and the importer read nothing more, so every Excel row wrote NULL. A
 * pharmacy count typed into a sheet was dropped with no warning.
 *
 * What this pins:
 *   1. The download has a "Pharmacy Workload" column after "PM Workload", in the header list, in the
 *      positional row array (a missing entry there would shift Status into the Pharmacies column),
 *      in the widths and in the number format.
 *   2. The download writes a blank cell for a trip that was not counted separately, never 0.
 *   3. A sheet built from THOSE headers imports with the figure: 4 stays 4, 0 stays 0, a blank cell
 *      stays NULL, and text is NULL with a warning naming the row.
 *   4. An older sheet with no such column is still recognised as the template, and reads NULL.
 */

const REPORT_PATH = "../src/components/outstation/expense-report.tsx";

function reportSource() {
  return readFileSync(new URL(REPORT_PATH, import.meta.url), "utf8");
}

function withoutLineComments(source: string) {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function templateHeaders(source: string): string[] {
  const block = source.match(/const expenseTemplateHeaders = \[([\s\S]*?)\] as const;/)?.[1];
  assert.ok(block, "expenseTemplateHeaders must still be declared in the expense report");
  return [...withoutLineComments(block).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function positionalRowHeaders(source: string): string[] {
  const block = source.match(/const rowValues = rows\.map\(\(row\) => \[([\s\S]*?)\]\);/)?.[1];
  assert.ok(block, "the download must still build its rows as a positional array");
  return withoutLineComments(block)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.match(/^row\["([^"]+)"\]$/)?.[1] ?? entry.match(/^row\.(\w+)$/)?.[1] ?? entry);
}

function numberFormatColumns(source: string, format: string): number[] {
  const escaped = format.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&");
  const pattern = new RegExp(
    `\\[([\\d,\\s]+)\\]\\.forEach\\(\\(columnNumber\\) => \\{\\s*sheet\\.getColumn\\(columnNumber\\)\\.numFmt = "${escaped}"`,
  );
  const list = source.match(pattern)?.[1];
  assert.ok(list, `the download must still set the ${format} number format by column number`);
  return list.split(",").map((value) => Number(value.trim()));
}

function columnWidths(source: string): number[] {
  const list = source.match(/width: \[([\d,\s]+)\]\[index\]/)?.[1];
  assert.ok(list, "the download must still size its columns from one width list");
  return list.split(",").map((value) => Number(value.trim()));
}

const noDirectory: EmployeeLookupMaps = {
  codeByHrId: new Map(),
  codeByName: new Map(),
  residenceByHrId: new Map(),
  residenceByName: new Map(),
};

type SheetRow = Record<string, string | number | Date | null>;

function trip(tripId: string, pharmacies: string | number | null): SheetRow {
  return {
    "TripID": tripId,
    "Employee": "Dina Fadel",
    "HR ID": "B-12",
    "Role": "Medical Rep",
    "Start Date": new Date("2026-09-02T00:00:00Z"),
    "End Date": new Date("2026-09-02T00:00:00Z"),
    "Expense Type": "Medical Rep",
    "Transported By": "Bus",
    "Travel Stay Type": "Return same day",
    "To": "Damanhour",
    "Destination": "Damanhour",
    "KM": 67,
    "Travel Cost (auto)": 242,
    "Meeting Amount": 0,
    "Allowance": 125,
    "Total": 367,
    "AM Workload": 2,
    "PM Workload": 8,
    "Pharmacy Workload": pharmacies,
    "Status": "Approved",
    "Comments": "",
  };
}

/** A sheet laid out exactly as the download lays it out: a title row, then the headers on row 2. */
async function templateFile(headers: string[], rows: SheetRow[], fileName: string) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Outstation expenses");
  sheet.mergeCells(1, 1, 1, headers.length);
  sheet.getCell("A1").value = `Outstation expenses - ${rows.length} trip(s)`;
  sheet.getRow(2).values = [...headers];
  for (const row of rows) {
    sheet.addRow(headers.map((header) => row[header] ?? null));
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer as ArrayBuffer], fileName);
}

export async function runOutstationExpenseTemplatePharmaciesTests() {
  const source = reportSource();
  const headers = templateHeaders(source);

  // ── 1. The download carries the column, in every place a column is declared ─────────────────
  const pharmacyIndex = headers.indexOf("Pharmacy Workload");
  assert.ok(pharmacyIndex > -1, "the downloaded template must carry a Pharmacy Workload column");
  assert.equal(
    pharmacyIndex,
    headers.indexOf("PM Workload") + 1,
    "Pharmacy Workload sits straight after PM Workload, so the three figures read AM · PM · Pharmacies",
  );
  assert.deepEqual(
    positionalRowHeaders(source),
    headers,
    "the positional row array must list every header in the same order — a missing entry shifts " +
      "Status into the Pharmacies column and Comments into Status",
  );
  assert.equal(columnWidths(source).length, headers.length, "every template column needs its own width");
  const numeric = numberFormatColumns(source, "#,##0.00");
  assert.ok(
    numeric.includes(pharmacyIndex + 1),
    "the Pharmacies column takes the same number format as AM Workload and PM Workload",
  );
  assert.ok(!numeric.includes(headers.indexOf("Status") + 1), "the Status column is text, never a number format");

  // ── 2. Not counted separately downloads as a blank cell, never 0 ────────────────────────────
  assert.ok(
    source.includes('"Pharmacy Workload": record.pharmacyWorkload ?? "",'),
    "a trip whose pharmacies were not counted separately must download as a blank cell — a 0 would " +
      "claim they were counted and none were visited, and would import back as a real zero",
  );

  // ── 3. A sheet built from the download's own headers imports with the figure ────────────────
  const current = await analyzeExpenseWorkbook(
    await templateFile(
      headers,
      [trip("XL-1", 4), trip("XL-2", null), trip("XL-3", 0), trip("XL-4", "n/a")],
      "phoenix-outstation-expenses-2026-09-21.xlsx",
    ),
    { employeeMaps: noDirectory },
  );
  assert.equal(current.template?.recognized, true, "the current template is recognised");
  const byTrip = new Map(current.records.map((record) => [record.tripId, record]));
  assert.equal(byTrip.size, 4, "all four rows import");
  assert.equal(byTrip.get("XL-1")?.pharmacyWorkload, 4, "a counted pharmacy figure imports as that figure");
  assert.equal(
    byTrip.get("XL-2")?.pharmacyWorkload,
    null,
    "a blank Pharmacy Workload cell imports as NULL (not counted separately), never 0",
  );
  assert.equal(byTrip.get("XL-3")?.pharmacyWorkload, 0, "a typed 0 is a real count and stays 0");
  assert.equal(byTrip.get("XL-4")?.pharmacyWorkload, null, "text in the cell is not a count");
  assert.ok(
    current.validation.warnings.some((warning) => warning.includes("XL-4") && warning.includes("Pharmacy Workload")),
    "a cell that is not a count is named to the uploader, never dropped silently",
  );
  assert.equal(byTrip.get("XL-1")?.amWorkload, 2, "AM still imports beside it");
  assert.equal(byTrip.get("XL-1")?.pmWorkload, 8, "PM still imports beside it");
  assert.equal(byTrip.get("XL-1")?.status, "Approved", "the column after Pharmacies still reads as Status");

  // ── 4. A sheet downloaded before the column existed still imports ───────────────────────────
  const olderHeaders = headers.filter((header) => header !== "Pharmacy Workload");
  const older = await analyzeExpenseWorkbook(
    await templateFile(olderHeaders, [trip("XL-OLD", 5)], "phoenix-outstation-expenses-2026-09-01.xlsx"),
    { employeeMaps: noDirectory },
  );
  assert.equal(
    older.template?.recognized,
    true,
    "a sheet from before the Pharmacies column is still the Phoenix template — the column is optional",
  );
  assert.deepEqual(older.template, current.template, "and it is recognised as the same template");
  assert.ok(
    !older.validation.missingRequiredColumns.includes("Pharmacy Workload"),
    "Pharmacy Workload is never reported as a missing required column",
  );
  assert.equal(older.records[0]?.pharmacyWorkload, null, "with no column, the figure is NULL (not counted)");
  assert.ok(
    !older.validation.warnings.some((warning) => warning.includes("Pharmacy Workload")),
    "a sheet without the column raises no pharmacy warning",
  );
}
