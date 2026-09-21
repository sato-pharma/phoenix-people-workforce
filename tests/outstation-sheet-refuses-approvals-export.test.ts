import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildPhoenixTableWorkbook, type ExportColumn } from "../src/lib/export/table-workbook.ts";
import {
  analyzeExpenseWorkbook,
  describeExpenseApprovalsDownloadRefusal,
  EXPENSE_APPROVALS_DOWNLOAD_COLUMNS,
  EXPENSE_APPROVALS_DOWNLOAD_SHEET_NAME,
  EXPENSE_APPROVALS_DOWNLOAD_TEMPLATE_KEY,
  unrecognizedExpenseTemplateMessage,
} from "../src/lib/outstation/expense-import.ts";
import {
  adminExportColumns,
  analyzeAdminExport,
  exportRow,
  noEmployees,
} from "./outstation-sheet-refuses-workflow-trip-ids.test.ts";

/**
 * The admin Expense Approvals download is never accepted as an upload (owner ruling, 2026-09-21).
 *
 * It shared 13 of the 16 template columns — exactly the pass mark — so uploading it back parsed with
 * zero errors, and every trip in it was upserted on `trip_id` IN PLACE: workload read as 0, Other and
 * the deduction dropped, the HR comment lost, and the trip moved into the new upload's report. #4188
 * refuses the download's app trips; this pins the refusal of the file itself, which is what protects
 * the historical (sheet-imported) trips — 327 of them on production that day.
 *
 * The workbook is built from the download route's REAL column labels, so this proves the vector, not
 * a hand-made look-alike. The refusal has two independent triggers, and this covers both: any one of
 * the download's own columns, and — even with all of them hand-deleted — the download's worksheet
 * name "Expense Approvals". Both the columns and the name are pinned to what export/route.ts writes.
 */

// A historical trip as the download writes it: dated before July, with workload, an Other amount, a
// deduction and an HR comment — every value the old re-import silently rewrote.
const historicalTrip = exportRow({
  allowance: 150,
  approvedAmount: 450,
  claimedTotal: 500,
  deduction: 50,
  hrComment: "Checked against the June sheet",
  hrId: "B-155",
  meetingAmount: 100,
  other: 50,
  reportId: "report-historical",
  sourceFileName: "june-historical.xlsx",
  specialist: "Ahmed Sharaf",
  travelCost: 200,
  tripEndDate: "2026-06-12",
  tripId: "T-1001",
  tripStartDate: "2026-06-12",
  workloadAm: 3,
  workloadPm: 5,
});

// The Phoenix Outstation Expenses template's own headers — all 16 it requires, plus HR ID.
const templateColumns: ExportColumn[] = [
  "TripID", "Employee", "HR ID", "Start Date", "End Date", "Expense Type", "Transported By",
  "Travel Stay Type", "To", "Travel Cost", "Meeting Amount", "Allowance", "Total", "KM",
  "AM Workload", "PM Workload", "Status",
].map((label) => ({ key: label, label }));

const templateRow = {
  "AM Workload": 3,
  Allowance: 150,
  Employee: "Ahmed Sharaf",
  "End Date": "2026-06-12",
  "Expense Type": "traveling",
  "HR ID": "B-155",
  KM: 90,
  "Meeting Amount": 100,
  "PM Workload": 5,
  "Start Date": "2026-06-12",
  Status: "Approved",
  To: "Tanta",
  Total: 450,
  "Transported By": "Car",
  "Travel Cost": 200,
  "Travel Stay Type": "Return same day",
  TripID: "T-2001",
};

async function analyzeSheet(
  columns: ExportColumn[],
  rows: Array<Record<string, string | number>>,
  sheetName = "Outstation Expenses",
) {
  const buffer = await buildPhoenixTableWorkbook({
    columns,
    rows,
    sheetName,
    subtitle: "regression fixture",
    title: "Historical outstation expenses",
  });
  const file = new File([buffer as ArrayBuffer], "historical-expenses-2026-06.xlsx");
  return analyzeExpenseWorkbook(file, { employeeMaps: noEmployees });
}

export async function runOutstationSheetRefusesApprovalsExportTests() {
  const refusalText = describeExpenseApprovalsDownloadRefusal();

  // -- The download's signature is still what the download writes ------------------------------
  const downloadLabels = adminExportColumns().map((column) => column.label);
  for (const label of EXPENSE_APPROVALS_DOWNLOAD_COLUMNS) {
    assert.ok(
      downloadLabels.includes(label),
      `the Expense Approvals download still writes a "${label}" column — rename it there and the importer stops recognising the download`,
    );
  }

  // -- HEADLINE: the download of historical trips is refused as a file -------------------------
  const refused = await analyzeAdminExport([historicalTrip]);
  assert.equal(refused.records.length, 1, "the download parses — the refusal is about the file, not an unreadable row");
  assert.ok(
    refused.validation.errors.includes(refusalText),
    "HEADLINE: the Expense Approvals download of historical trips is refused at analysis, before either upload route saves or the replace route clears its report",
  );
  assert.equal(refused.template?.recognized, false, "the download is not a recognised upload template");
  assert.equal(refused.template?.key, EXPENSE_APPROVALS_DOWNLOAD_TEMPLATE_KEY);
  assert.equal(refused.validation.status, "failed");
  assert.equal(
    refused.validation.errors.filter((error) => /does not match the Phoenix Outstation Expenses template/.test(error)).length,
    0,
    "one clear reason, not the generic mismatch line beside it",
  );

  // The banner the uploader reads is the route's `message`, which now comes from the domain.
  assert.equal(unrecognizedExpenseTemplateMessage(refused), refusalText, "the upload banner says it is the download");
  assert.equal(
    unrecognizedExpenseTemplateMessage({ template: { key: "generic-expenses-v1", name: "", recognized: false } }),
    "Unrecognized expense template. Please upload the Phoenix Outstation Expenses template.",
    "any other unrecognised sheet keeps the sentence it always had",
  );

  // The refusal is plain words about the file: no trip id, and it says nothing was written.
  assert.match(refusalText, /Expense Approvals download/);
  assert.match(refusalText, /nothing was imported and no saved upload was changed/);
  assert.doesNotMatch(refusalText, /T-1001|OUTSTATION\s*-/i, "names no trip and no id");

  // -- Any ONE download column is enough ------------------------------------------------------
  // A download with some of its columns deleted must still be refused, so each signature column is
  // tried alone on an otherwise genuine template sheet.
  for (const label of EXPENSE_APPROVALS_DOWNLOAD_COLUMNS) {
    const analysis = await analyzeSheet(
      [...templateColumns, { key: "extra", label }],
      [{ ...templateRow, extra: 1 }],
    );
    assert.ok(analysis.validation.errors.includes(refusalText), `a sheet carrying "${label}" is refused as the download`);
  }

  // -- The worksheet NAME alone is enough, even with every signature column deleted -------------
  // The download names its sheet "Expense Approvals"; the importer's constant must still be what the
  // route writes, or a rename there would silently reopen the hole a different way.
  assert.equal(
    EXPENSE_APPROVALS_DOWNLOAD_SHEET_NAME,
    "Expense Approvals",
    "the download's worksheet name is pinned to what export/route.ts writes",
  );
  const routeSource = readFileSync("app/api/admin/outstation/expenses/export/route.ts", "utf8");
  assert.match(
    routeSource,
    new RegExp(`sheetName:\\s*"${EXPENSE_APPROVALS_DOWNLOAD_SHEET_NAME}"`),
    "the Expense Approvals download still names its worksheet that — rename it there and the sheet-name refusal misses",
  );
  // A hand-stripped download: the plain template columns, none of the five signatures, but the sheet
  // is still named "Expense Approvals". The column check cannot see it; the sheet-name check must.
  const strippedButNamed = await analyzeSheet(templateColumns, [templateRow], EXPENSE_APPROVALS_DOWNLOAD_SHEET_NAME);
  assert.ok(
    strippedButNamed.validation.errors.includes(refusalText),
    "a download with every signature column deleted is still refused by its worksheet name",
  );
  assert.equal(strippedButNamed.template?.key, EXPENSE_APPROVALS_DOWNLOAD_TEMPLATE_KEY);
  assert.equal(strippedButNamed.template?.recognized, false);

  // -- Control: a real historical template sheet still imports --------------------------------
  const genuine = await analyzeSheet(templateColumns, [templateRow]);
  assert.equal(genuine.template?.recognized, true, "the Phoenix Outstation Expenses template is still recognised");
  assert.deepEqual(genuine.validation.errors, [], "and a genuine historical sheet is not refused");
  assert.equal(genuine.records[0]?.amWorkload, 3, "its workload is read");
  assert.equal(genuine.records[0]?.total, 450);

  // #4188's app-trip refusal still fires end to end on a sheet that IS the template — its own fixture
  // is the download, which is now refused for this second reason as well.
  const appTripOnTemplate = await analyzeSheet(templateColumns, [{ ...templateRow, TripID: "OUTSTATION-72" }]);
  assert.equal(appTripOnTemplate.template?.recognized, true, "a template sheet carrying an app trip is still the template");
  assert.ok(
    appTripOnTemplate.validation.errors.some((error) => /submitted in the Phoenix app/.test(error)),
    "and its app-trip row is refused at analysis",
  );
  assert.ok(!appTripOnTemplate.validation.errors.includes(refusalText), "without being mistaken for the download");

  // -- Wiring: both upload routes stop on the refusal before they write or clear ---------------
  for (const route of [
    "app/api/admin/outstation/expenses/analyze/route.ts",
    "app/api/admin/outstation/expenses/reports/[id]/route.ts",
  ]) {
    const source = readFileSync(route, "utf8");
    const body = source.slice(source.indexOf("export async function POST") > -1
      ? source.indexOf("export async function POST")
      : source.indexOf("export async function PUT"));
    const templateGate = body.indexOf("if (!analysis.template?.recognized)");
    assert.ok(templateGate > -1, `${route}: still refuses an unrecognised template`);
    for (const write of ["clearPayrollExpenseReportRows(", "savePayrollExpenseApprovals("]) {
      const call = body.indexOf(write);
      if (call > -1) assert.ok(templateGate < call, `${route}: the template gate runs before ${write}`);
    }
    const gateBranch = body.slice(templateGate, body.indexOf("{ status: 400 }", templateGate));
    assert.match(
      gateBranch,
      /message: unrecognizedExpenseTemplateMessage\(analysis\)/,
      `${route}: the refusal banner comes from the domain, so it names the download`,
    );
  }
}
