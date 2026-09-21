import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildPhoenixTableWorkbook, type ExportColumn } from "../src/lib/export/table-workbook.ts";
import { analyzeExpenseWorkbook, type EmployeeLookupMaps } from "../src/lib/outstation/expense-import.ts";
import {
  assertNoWorkflowTripIds,
  describeWorkflowTripIdRefusal,
  findRowsCarryingWorkflowTripIds,
  isWorkflowTripId,
  WorkflowTripIdRefusedError,
} from "../src/lib/outstation/workflow-trip-id-guard.ts";

/**
 * A historical expense sheet may never write an app trip's payroll row (risk review, 2026-09-21).
 *
 * `outstation_expenses` upserts on `trip_id`, and the outstation workflow writes each app trip's
 * payroll row as `OUTSTATION-<request id>`. A sheet row carrying that id overwrote the trip's money
 * and workload instead of adding a trip — and the admin Expense Approvals export, which lists app
 * trips, re-imported as the Phoenix template with zero errors.
 *
 * The end-to-end half builds the workbook from the admin export's REAL header labels (read from the
 * export route), so it proves the vector exists, not just that a hand-made sheet is refused.
 */

// No database: the parse is given empty employee maps instead of reading the employee directory.
const noEmployees: EmployeeLookupMaps = {
  codeByHrId: new Map(),
  codeByName: new Map(),
  residenceByHrId: new Map(),
  residenceByName: new Map(),
};

function adminExportColumns(): ExportColumn[] {
  const source = readFileSync("app/api/admin/outstation/expenses/export/route.ts", "utf8");
  const columns = [...source.matchAll(/\{ key: "(\w+)", label: "([^"]+)"(, numeric: true)? \}/g)].map(
    (match) => ({ key: match[1], label: match[2], numeric: Boolean(match[3]) }),
  );
  assert.ok(
    columns.some((column) => column.label === "Trip ID"),
    "the admin export route must still be readable here: its COLUMNS list carries a Trip ID column",
  );
  return columns;
}

function exportRow(overrides: Record<string, string | number>) {
  return {
    allowance: 0,
    approvedAmount: 323.14,
    approvedAt: "",
    approvedBy: "",
    claimedTotal: 323.14,
    deduction: 0,
    destination: "Tanta",
    distanceFlag: "",
    expenseType: "traveling",
    from: "Cairo",
    hrComment: "",
    hrId: "B-12",
    km: 90,
    meetingAmount: 0,
    other: 0,
    reportId: "report-1",
    sourceFileName: "outstation-request-72.workflow",
    specialist: "Dina Hamdy Fadel Mohamed Bdair",
    status: "Approved",
    transportationType: "Car",
    travelCost: 323.14,
    tripEndDate: "2026-08-12",
    tripId: "OUTSTATION-72",
    tripStartDate: "2026-08-12",
    tripType: "Return same day",
    workloadAm: 3,
    workloadPm: 5,
    ...overrides,
  };
}

async function analyzeAdminExport(rows: Array<Record<string, string | number>>) {
  const buffer = await buildPhoenixTableWorkbook({
    columns: adminExportColumns(),
    rows,
    sheetName: "Expense Approvals",
    subtitle: "regression fixture",
    title: "Phoenix Workforce — Expense Approvals",
  });
  const file = new File([buffer as ArrayBuffer], "expense-approvals-2026-09.xlsx");
  return analyzeExpenseWorkbook(file, { employeeMaps: noEmployees });
}

export async function runOutstationSheetRefusesWorkflowTripIdsTests() {
  // -- The reserved namespace -----------------------------------------------------------------
  assert.equal(isWorkflowTripId("OUTSTATION-72"), true, "the workflow's own trip id is reserved");
  assert.equal(isWorkflowTripId(" OUTSTATION-72 "), true, "surrounding spaces do not escape it");
  assert.equal(isWorkflowTripId("outstation-72"), true, "nor does lower case");
  assert.equal(isWorkflowTripId("OUTSTATION - 72"), true, "nor spacing around the hyphen");
  assert.equal(isWorkflowTripId("ROW-3F2A9C1B7D04"), false, "a synthetic sheet id is not reserved");
  assert.equal(isWorkflowTripId("T-1001"), false, "an ordinary sheet TripID is not reserved");
  assert.equal(isWorkflowTripId("XOUTSTATION-72"), false, "the prefix must lead");
  assert.equal(isWorkflowTripId(""), false);
  assert.equal(isWorkflowTripId(null), false);

  // -- The refusal names people and rows, never trip ids, and says DELETE ----------------------
  const rows = findRowsCarryingWorkflowTripIds([
    { row: 4, specialist: "Dina Hamdy Fadel Mohamed Bdair", tripId: "OUTSTATION-72" },
    { row: 5, specialist: "Ahmed Sharaf", tripId: "T-1001" },
    { row: 9, specialist: "Dina Hamdy Fadel Mohamed Bdair", tripId: "OUTSTATION-99" },
    { row: 7, specialist: "Unassigned", tripId: "outstation-52" },
  ]);
  assert.deepEqual(
    rows.map((entry) => entry.row),
    [4, 9, 7],
    "every reserved row is found, and only those",
  );
  const message = describeWorkflowTripIdRefusal(rows);
  assert.match(message, /Dina Hamdy Fadel Mohamed Bdair \(rows 4, 9\)/, "one entry per person, every row listed");
  assert.match(message, /No employee name \(row 7\)/, "a nameless row is still listed by its row");
  assert.match(message, /\b3 rows belong\b/);
  assert.match(message, /Delete those rows/, "the fix offered is deleting the rows");
  assert.match(
    message,
    /downloaded from Phoenix is never uploaded back/,
    "and a Phoenix download is never uploaded back at all: every row in it is already in the system",
  );
  assert.doesNotMatch(message, /OUTSTATION\s*-|\b(72|99|52)\b/i, "names and rows, never the trip id");
  assert.doesNotMatch(
    message,
    /clear|blank|empty/i,
    "never suggests blanking the Trip ID: a blank TripID gets a new id and imports the trip as a second payable row",
  );

  assert.throws(
    () => assertNoWorkflowTripIds([{ row: 4, specialist: "Dina Hamdy Fadel Mohamed Bdair", tripId: "OUTSTATION-72" }]),
    (error: unknown) => error instanceof WorkflowTripIdRefusedError && error.rows.length === 1,
    "the write-side assertion refuses a reserved id",
  );
  assert.doesNotThrow(
    () => assertNoWorkflowTripIds([{ row: 5, specialist: "Ahmed Sharaf", tripId: "T-1001" }]),
    "and lets an ordinary sheet row through",
  );

  // -- End to end: the admin export re-imports, and its app trips are refused -----------------
  const exported = await analyzeAdminExport([
    exportRow({}),
    exportRow({
      specialist: "Ahmed Sharaf",
      hrId: "B-155",
      sourceFileName: "july-historical.xlsx",
      tripId: "T-1001",
    }),
  ]);
  assert.equal(
    exported.template?.recognized,
    true,
    "the admin Expense Approvals export is accepted as the Phoenix template — which is why the importer itself must refuse app trips",
  );
  assert.equal(exported.records.length, 2, "both rows parse, so the refusal comes from the trip id and nothing else");
  const refusal = exported.validation.errors.find((error) => /submitted in the Phoenix app/.test(error));
  assert.ok(
    refusal,
    "HEADLINE: a sheet row carrying an app trip's id is refused at analysis, before either upload route writes or clears anything",
  );
  assert.match(refusal, /Dina Hamdy Fadel Mohamed Bdair \(row \d+\)/, "the uploader is told whose row, by name");
  assert.doesNotMatch(refusal, /Ahmed Sharaf/, "the ordinary row is not named");
  assert.equal(exported.validation.status, "failed");

  // Control: the same export without the app trip imports cleanly, so the refusal above is the guard.
  const historicalOnly = await analyzeAdminExport([
    exportRow({ specialist: "Ahmed Sharaf", hrId: "B-155", sourceFileName: "july-historical.xlsx", tripId: "T-1001" }),
  ]);
  assert.deepEqual(historicalOnly.validation.errors, [], "a sheet with no app trip is not refused");

  // -- Wiring the database round-trip cannot execute here --------------------------------------
  // Both upload routes stop on validation errors before they save — the replace route before it
  // clears its report, which is why the refusal must live in the analysis and not only in the save.
  for (const route of [
    "app/api/admin/outstation/expenses/analyze/route.ts",
    "app/api/admin/outstation/expenses/reports/[id]/route.ts",
  ]) {
    const source = readFileSync(route, "utf8");
    const errorsGate = source.indexOf("analysis.validation.errors.length > 0");
    assert.ok(errorsGate > -1, `${route}: still refuses an analysis with validation errors`);
    for (const write of ["clearPayrollExpenseReportRows(", "savePayrollExpenseApprovals("]) {
      const call = source.indexOf(write, source.indexOf("export async function"));
      if (call > -1) assert.ok(errorsGate < call, `${route}: the validation gate runs before ${write}`);
    }
    assert.doesNotMatch(source, /allowWorkflowTripIds/, `${route}: a route never opts out of the guard`);
  }

  // The save refuses a reserved id before its first read and before it mints a report row.
  const expenses = readFileSync("src/lib/outstation/expenses.ts", "utf8");
  const saveBody = expenses.slice(expenses.indexOf("export async function savePayrollExpenseApprovals"));
  const guard = saveBody.indexOf("assertNoWorkflowTripIds(input.records)");
  assert.ok(guard > -1, "savePayrollExpenseApprovals refuses a reserved trip id itself");
  assert.ok(guard < saveBody.indexOf("readExistingExpenseRows("), "before its first database read");
  assert.ok(guard < saveBody.indexOf('.from("outstation_expense_reports")'), "and before any report row is written");
  assert.match(saveBody.slice(0, guard), /if \(!options\?\.allowWorkflowTripIds\)/);

  // Only the workflow opts out — and every one of its pushes does, or accepted app trips would stop
  // reaching payroll.
  const service = readFileSync("src/lib/outstation/service.ts", "utf8");
  const workflowSaves = service.split("await savePayrollExpenseApprovals(").slice(1);
  assert.equal(workflowSaves.length, 3, "the workflow pushes an app trip to payroll from exactly three places");
  for (const call of workflowSaves) {
    const args = call.slice(0, call.indexOf(");"));
    assert.match(args, /allowWorkflowTripIds: true/, "each workflow push declares itself");
  }
  const approvalsRoute = readFileSync("app/api/admin/outstation/expenses/route.ts", "utf8");
  assert.doesNotMatch(approvalsRoute, /allowWorkflowTripIds/, "the approvals screen's save never opts out");
  // A reserved id that is not a request's exact id falls to the payroll save, which refuses it — the
  // route has to refuse it first, or the request decisions in the same Save are already committed.
  const reservedCheck = approvalsRoute.indexOf("findRowsCarryingWorkflowTripIds(payrollRecords)");
  assert.ok(reservedCheck > -1, "the approvals route refuses a reserved-but-not-exact trip id itself");
  assert.ok(
    reservedCheck < approvalsRoute.indexOf("await applyOutstationRequestExpenseDecisions("),
    "before it commits any request decision",
  );

  // THE WHOLE SHEET IS REFUSED (owner, 2026-09-21). The refused rows stay on screen for HR to read,
  // but Save must not post them: the approvals route would import the refused sheet through a second
  // door and re-decide its app trips with the sheet's defaults.
  const report = readFileSync("src/components/outstation/expense-report.tsx", "utf8");
  assert.match(report, /const analysisRefused = validation\.status === "failed";/);
  assert.match(
    report,
    /disabled=\{!analysis \|\| savingApprovals \|\| analysisRefused\}\s*onClick=\{saveApprovals\}/,
    "the Save HR/Admin Approvals button is locked on a refused upload",
  );
  assert.match(report, /function saveApprovals\(\) \{\s*if \(!analysis \|\| analysisRefused\) return;/);
  // Nor can a decision be MADE on a refused row: drafts are kept by trip id and outlive the screen,
  // so a tick recorded here would reappear, and save, on the saved report holding the same trip.
  assert.match(
    report,
    /<fieldset className="[^"]*" disabled=\{locked\}>/,
    "the HR decision controls (switch, amount, reason) sit in one fieldset that the lock disables",
  );
  const decisionControlUses = report.match(/<HrDecisionControls\s/g) ?? [];
  assert.ok(decisionControlUses.length >= 2, "desktop row and mobile card both render the controls");
  assert.equal(
    (report.match(/locked=\{analysisRefused\}/g) ?? []).length,
    decisionControlUses.length,
    "every place that renders the decision controls locks them on a refused upload",
  );
  assert.match(
    report,
    /function updateApproval\([\s\S]{0,200}?\) \{[\s\S]{0,300}?if \(analysis\?\.validation\?\.status === "failed"\) return;\s*setApprovals/,
    "and the draft store itself records nothing on a refused upload",
  );
  const workspace = readFileSync("src/components/outstation/expenses-review-workspace.tsx", "utf8");
  const saveHandler = workspace.slice(workspace.indexOf("async function handleSaveExpenseApprovals"));
  assert.ok(
    saveHandler.indexOf('expenseAnalysis.validation?.status === "failed") return;') > -1 &&
      saveHandler.indexOf('expenseAnalysis.validation?.status === "failed") return;') <
        saveHandler.indexOf('fetch("/api/admin/outstation/expenses"'),
    "the save handler refuses a refused upload before it posts anything",
  );
}
