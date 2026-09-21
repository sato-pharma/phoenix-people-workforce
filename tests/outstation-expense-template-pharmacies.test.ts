import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";
import ts from "typescript";

import { analyzeExpenseWorkbook, type EmployeeLookupMaps } from "../src/lib/outstation/expense-import.ts";

/**
 * The Excel expense template carries the third workload figure, AM · PM · Pharmacies, both ways.
 *
 * THE GAP. The 2026-09-21 split gave every trip a `pharmacy_workload`, but the downloaded template
 * stopped at "PM Workload" and the importer read nothing more, so every Excel row wrote NULL. A
 * pharmacy count typed into a sheet was dropped with no warning.
 *
 * A SEPARATE, KNOWN DEFECT THIS TEST STEPS AROUND, ON PURPOSE. The download gives each column a
 * `header`, which ExcelJS writes into ROW 1 over the title, so row 1 reads "Comments" in every cell
 * and the importer refuses the downloaded file as it stands. It is NOT fixed here: that refusal is
 * what currently stops a re-uploaded download from resetting HR's decision on every trip in it (the
 * importer's rows carry no approval). The upload below puts the title back the way the code intends,
 * and so tests the importer against the download's own header row and cells.
 *
 * This test RUNS the download code lifted out of the component, so it checks the cells it writes, not
 * the source. What it pins:
 *   1. Row 2 carries "Pharmacy Workload" straight after "PM Workload", with the AM/PM number format
 *      and its own width, and Status still in the column after it.
 *   2. A trip not counted separately downloads as a blank cell, never 0.
 *   3. Those headers and cells import with the figure: 4 stays 4, 0 stays 0, blank stays NULL.
 *   4. Text in the cell is NULL with a warning naming the row.
 *   5. An older sheet with no such column is still recognised as the template, and reads NULL.
 */

const REPORT_PATH = "../src/components/outstation/expense-report.tsx";

type TripFixture = Record<string, unknown>;

function reportSource() {
  return readFileSync(new URL(REPORT_PATH, import.meta.url), "utf8");
}

function slice(source: string, from: string, to: string, what: string) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start > -1 && end > start, `positive control: ${what} is still in the expense report`);
  return source.slice(start, end);
}

/**
 * The component's own download code, compiled to plain JS: the module-level header list and the two
 * cell helpers, then the body of downloadFilteredExpenses() up to the point it turns the workbook
 * into a browser download. `approvalFor` is a stub, because it reads component state.
 */
function downloadBuilder(): (records: TripFixture[]) => Promise<ExcelJS.Workbook> {
  const source = reportSource();
  const pieces = [
    slice(source, "const expenseTemplateHeaders = [", "type ExpenseTemplateHeader", "the template header list"),
    slice(source, "function expenseTemplateComment(", "// Geography fields are excluded", "the two cell helpers"),
    slice(
      source,
      "const workbook = new ExcelJS.Workbook();",
      "const output = await workbook.xlsx.writeBuffer();",
      "the download's workbook builder",
    ),
  ];
  const compiled = ts.transpileModule(
    [
      "async function build(ExcelJS: any, records: any[]) {",
      "  const approvalFor = () => ({ hrApproved: false, hrComment: \"\" });",
      ...pieces,
      "  return workbook;",
      "}",
    ].join("\n"),
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const build = new Function(`${compiled}\nreturn build;`)() as (
    excel: typeof ExcelJS,
    records: TripFixture[],
  ) => Promise<ExcelJS.Workbook>;
  return (records) => build(ExcelJS, records);
}

const noDirectory: EmployeeLookupMaps = {
  codeByHrId: new Map(),
  codeByName: new Map(),
  residenceByHrId: new Map(),
  residenceByName: new Map(),
};

function trip(tripId: string, pharmacyWorkload: number | null): TripFixture {
  return {
    allowance: 125,
    amWorkload: 2,
    date: "2026-09-02",
    description: "",
    from: "Alexandria",
    hr: "",
    hrId: "B-12",
    hrNotes: "",
    km: 67,
    location: "Damanhour",
    meetingAmount: 0,
    other: 0,
    pharmacyWorkload,
    pmWorkload: 8,
    requestType: "Medical Rep",
    row: 0,
    specialist: "Dina Fadel",
    status: "Approved",
    to: "Damanhour",
    toDate: "2026-09-02",
    total: 367,
    transportationType: "Bus",
    travelCost: 242,
    tripId,
    tripType: "Return same day",
  };
}

function headerCells(sheet: ExcelJS.Worksheet) {
  const row = sheet.getRow(2);
  return Array.from({ length: sheet.columnCount }, (_, index) => String(row.getCell(index + 1).value ?? ""));
}

/** Row 1 as the download code intends it: the title alone. See "A SEPARATE, KNOWN DEFECT" above. */
async function asUpload(workbook: ExcelJS.Workbook, fileName: string) {
  const sheet = workbook.getWorksheet("Outstation expenses");
  assert.ok(sheet, "the upload is built from the download's own sheet");
  sheet.getCell("A1").value = "Outstation expenses";
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer as ArrayBuffer], fileName);
}

export async function runOutstationExpenseTemplatePharmaciesTests() {
  const build = downloadBuilder();
  const downloaded = await build([trip("XL-1", 4), trip("XL-2", null), trip("XL-3", 0)]);
  const sheet = downloaded.getWorksheet("Outstation expenses");
  assert.ok(sheet, "the download builds its Outstation expenses sheet");

  // ── 1. The file's layout ─────────────────────────────────────────────────────────────────────
  const headers = headerCells(sheet);
  const pharmacyColumn = headers.indexOf("Pharmacy Workload") + 1;
  assert.ok(pharmacyColumn > 0, "the downloaded template must carry a Pharmacy Workload column");
  assert.equal(
    pharmacyColumn,
    headers.indexOf("PM Workload") + 2,
    "Pharmacy Workload sits straight after PM Workload, so the three figures read AM · PM · Pharmacies",
  );
  assert.equal(sheet.getColumn(pharmacyColumn).numFmt, "#,##0.00", "it takes the AM and PM number format");
  assert.equal(sheet.getColumn(headers.indexOf("Status") + 1).numFmt, undefined, "Status stays text");
  headers.forEach((header, index) => {
    assert.ok(sheet.getColumn(index + 1).width, `every template column has its own width — ${header} has none`);
  });
  assert.equal(
    sheet.getRow(3).getCell(headers.indexOf("Status") + 1).value,
    "Approved",
    "Status lands under Status — a column missing from the row array shifts it into Pharmacies",
  );

  // ── 2. Not counted separately downloads as a blank cell, never 0 ────────────────────────────
  const cell = (row: number) => sheet.getRow(row).getCell(pharmacyColumn).value;
  assert.equal(cell(3), 4, "a counted figure downloads as that figure");
  assert.ok(
    cell(4) === "" || cell(4) === null || cell(4) === undefined,
    `a trip whose pharmacies were not counted separately downloads as a blank cell, never 0 — got ${JSON.stringify(cell(4))}`,
  );
  assert.equal(cell(5), 0, "a counted 0 downloads as 0");

  // ── 3. The download's own headers and cells import with the figure ──────────────────────────
  const roundTrip = await analyzeExpenseWorkbook(
    await asUpload(downloaded, "phoenix-outstation-expenses-2026-09-21.xlsx"),
    { employeeMaps: noDirectory },
  );
  assert.equal(
    roundTrip.template?.recognized,
    true,
    "a sheet with the download's own header row is recognised as the Phoenix template",
  );
  const byTrip = new Map(roundTrip.records.map((record) => [record.tripId, record]));
  assert.equal(byTrip.size, 3, "all three downloaded rows import");
  assert.equal(byTrip.get("XL-1")?.pharmacyWorkload, 4, "a counted pharmacy figure imports as that figure");
  assert.equal(
    byTrip.get("XL-2")?.pharmacyWorkload,
    null,
    "a blank Pharmacy Workload cell imports as NULL (not counted separately), never 0",
  );
  assert.equal(byTrip.get("XL-3")?.pharmacyWorkload, 0, "a typed 0 is a real count and stays 0");
  assert.equal(byTrip.get("XL-1")?.amWorkload, 2, "AM still imports beside it");
  assert.equal(byTrip.get("XL-1")?.pmWorkload, 8, "PM still imports beside it");
  assert.equal(
    byTrip.get("XL-1")?.status,
    "Approved",
    "Status still lands in Status — a column missing from the row array would shift it into Pharmacies",
  );

  // ── 4. Text in the cell is not a count, and the uploader is told ─────────────────────────────
  const edited = await build([trip("XL-4", 1)]);
  const editedSheet = edited.getWorksheet("Outstation expenses");
  assert.ok(editedSheet, "the download builds its sheet for a second file");
  editedSheet.getRow(3).getCell(pharmacyColumn).value = "n/a";
  const withText = await analyzeExpenseWorkbook(
    await asUpload(edited, "phoenix-outstation-expenses-2026-09-21.xlsx"),
    { employeeMaps: noDirectory },
  );
  assert.equal(withText.records[0]?.pharmacyWorkload, null, "text in the cell is not a count");
  assert.ok(
    withText.validation.warnings.some((warning) => warning.includes("XL-4") && warning.includes("Pharmacy Workload")),
    "a cell that is not a count is named to the uploader, never dropped silently",
  );

  // ── 5. A sheet downloaded before the column existed still imports ───────────────────────────
  const older = await build([trip("XL-OLD", 5)]);
  const olderSheet = older.getWorksheet("Outstation expenses");
  assert.ok(olderSheet, "the download builds its sheet for a third file");
  olderSheet.spliceColumns(pharmacyColumn, 1);
  const olderUpload = await analyzeExpenseWorkbook(
    await asUpload(older, "phoenix-outstation-expenses-2026-09-01.xlsx"),
    { employeeMaps: noDirectory },
  );
  assert.equal(
    olderUpload.template?.recognized,
    true,
    "a sheet from before the Pharmacies column is still the Phoenix template — the column is optional",
  );
  assert.ok(
    !olderUpload.validation.missingRequiredColumns.includes("Pharmacy Workload"),
    "Pharmacy Workload is never reported as a missing required column",
  );
  assert.equal(olderUpload.records[0]?.pharmacyWorkload, null, "with no column, the figure is NULL (not counted)");
  assert.equal(olderUpload.records[0]?.status, "Approved", "and the older layout still reads its Status");
  assert.ok(
    !olderUpload.validation.warnings.some((warning) => warning.includes("Pharmacy Workload")),
    "a sheet without the column raises no pharmacy warning",
  );
}
