import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  appTripRowsInReport,
  describeWorkflowExpenseReportRefusal,
  historicalUploadReports,
  isWorkflowExpenseReport,
  isWorkflowExpenseReportFileName,
  isWorkflowExpenseReportProtected,
  planExpenseReportMutation,
  workflowExpenseReportFileName,
  WorkflowExpenseReportProtectedError,
} from "../src/lib/outstation/workflow-expense-report-guard.ts";
import { applyLiveExpenseReportCounts } from "../src/lib/outstation/expense-report-live-counts.ts";
import type { PayrollExpenseReport } from "../src/lib/payroll/types.ts";

/**
 * The uploads list may never delete or replace an app trip's payroll report (risk review of #4188,
 * 2026-09-21).
 *
 * The outstation workflow mints one report per app trip (`outstation-request-<id>.workflow`) holding
 * that trip's payroll row. The admin screen listed those reports under "Historical Outstation Uploads"
 * with Replace and Delete, and both remove every row of the report — so one click took an accepted trip
 * out of payroll while its request still read accepted. The only lock was the paid stamp, which none
 * of them carry yet and which a Super Admin bypasses. On production that day: 83 of 94 reports.
 *
 * NO DATABASE. The suite runs with production credentials, so this never calls the real
 * `deletePayrollExpenseReport` or `clearPayrollExpenseReportRows`: the decision is a pure planner and
 * is tested as behaviour; the reads and deletes around it are pinned by source.
 */

type Row = {
  hr_approved: boolean;
  hr_id: string;
  imported_payroll_batch_id: string | null;
  imported_to_payroll_at: string | null;
  specialist: string;
  trip_id: string;
};

function row(overrides: Partial<Row>): Row {
  return {
    hr_approved: true,
    hr_id: "B-155",
    imported_payroll_batch_id: null,
    imported_to_payroll_at: null,
    specialist: "Ahmed Sharaf",
    trip_id: "T-1001",
    ...overrides,
  };
}

// The shape of the 80 production workflow rows: one app trip, approved, not yet paid.
const appTrip = row({ hr_id: "B-12", specialist: "Dina Hamdy Fadel Mohamed Bdair", trip_id: "OUTSTATION-72" });
const workflowName = "outstation-request-72.workflow";

function body(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  assert.ok(from > -1, `source still declares: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `source still has ${end} after ${start}`);
  return source.slice(from, to);
}

export async function runOutstationWorkflowReportDeleteGuardTests() {
  // -- Which report is the workflow's --------------------------------------------------------------
  assert.equal(
    workflowExpenseReportFileName(72),
    workflowName,
    "the workflow's report name is exactly the one on production's 83 workflow reports",
  );
  assert.equal(isWorkflowExpenseReportFileName(workflowName), true);
  assert.equal(isWorkflowExpenseReportFileName(" OUTSTATION-REQUEST-72.WORKFLOW "), true, "case and spaces do not escape it");
  assert.equal(isWorkflowExpenseReportFileName("july-historical.xlsx"), false, "an uploaded sheet is not a workflow report");
  assert.equal(isWorkflowExpenseReportFileName("workflow.xlsx"), false, "the suffix must end the name");
  assert.equal(isWorkflowExpenseReportFileName(""), false);
  assert.equal(isWorkflowExpenseReportFileName(null), false);

  assert.equal(isWorkflowExpenseReport({ fileName: workflowName, rows: [] }), true, "an EMPTY workflow report is caught by its name");
  assert.equal(
    isWorkflowExpenseReport({ fileName: "july-historical.xlsx", rows: [appTrip] }),
    true,
    "a report that lost its .workflow name to a save is still caught by the app trip inside it",
  );
  assert.equal(
    isWorkflowExpenseReport({ fileName: "july-historical.xlsx", rows: [row({}), appTrip] }),
    true,
    "ANY app-trip row is enough: an upload holding one would delete that trip with it",
  );
  assert.equal(isWorkflowExpenseReport({ fileName: "july-historical.xlsx", rows: [row({})] }), false);
  assert.equal(
    isWorkflowExpenseReport({ fileName: "july-historical.xlsx", rows: [] }),
    false,
    "an empty real upload is not a workflow report (every-row would have said it was)",
  );
  assert.deepEqual(appTripRowsInReport([row({}), appTrip]), [appTrip]);

  // -- The decision, as behaviour ------------------------------------------------------------------
  const superAdminDelete = planExpenseReportMutation({ bypassPaidLock: true, fileName: workflowName, rows: [appTrip] });
  assert.equal(
    superAdminDelete.outcome,
    "workflow_report",
    "HEADLINE: an app trip's payroll report is refused even for a Super Admin, whose bypass skips the paid lock",
  );
  assert.deepEqual(superAdminDelete.outcome === "workflow_report" && superAdminDelete.appTripRows, [appTrip]);
  assert.equal(
    planExpenseReportMutation({ bypassPaidLock: false, fileName: workflowName, rows: [appTrip] }).outcome,
    "workflow_report",
    "and for every other role",
  );
  assert.equal(
    planExpenseReportMutation({ bypassPaidLock: true, fileName: workflowName, rows: [] }).outcome,
    "workflow_report",
    "an empty workflow report is refused too",
  );
  assert.equal(
    planExpenseReportMutation({ bypassPaidLock: true, fileName: "july-historical.xlsx", rows: [row({}), appTrip] }).outcome,
    "workflow_report",
    "an upload holding an app trip is refused, rather than deleting the trip with it",
  );

  // A real upload behaves exactly as it did before this change.
  assert.deepEqual(
    planExpenseReportMutation({ bypassPaidLock: false, fileName: "july-historical.xlsx", rows: [row({})] }),
    { outcome: "allowed", transitionFrom: "approved" },
  );
  assert.deepEqual(
    planExpenseReportMutation({ bypassPaidLock: false, fileName: "july-historical.xlsx", rows: [row({ hr_approved: false })] }),
    { outcome: "allowed", transitionFrom: "pending" },
  );
  assert.deepEqual(
    planExpenseReportMutation({ bypassPaidLock: false, fileName: "july-historical.xlsx", rows: [] }),
    { outcome: "allowed", transitionFrom: "pending" },
    "an empty real upload can still be deleted",
  );
  const paid = row({ imported_payroll_batch_id: "batch-1" });
  assert.deepEqual(
    planExpenseReportMutation({ bypassPaidLock: false, fileName: "july-historical.xlsx", rows: [row({}), paid] }),
    { outcome: "paid" },
    "a paid upload stays locked",
  );
  assert.deepEqual(
    planExpenseReportMutation({
      bypassPaidLock: false,
      fileName: "july-historical.xlsx",
      rows: [row({ imported_to_payroll_at: "2026-08-31T10:00:00Z" })],
    }),
    { outcome: "paid" },
    "either paid stamp locks it",
  );
  assert.deepEqual(
    planExpenseReportMutation({ bypassPaidLock: true, fileName: "july-historical.xlsx", rows: [paid] }),
    { outcome: "allowed", transitionFrom: null },
    "the Super Admin bypass still clears a paid upload, and still skips the transition check",
  );

  // -- The uploads list shows uploads -------------------------------------------------------------
  const reports = [
    { fileName: workflowName, id: "a" },
    { fileName: "july-historical.xlsx", id: "b" },
    { fileName: "outstation-request-9.workflow", id: "c" },
    { fileName: "june-historical.xlsx", id: "d" },
  ];
  assert.deepEqual(
    historicalUploadReports(reports).map((report) => report.id),
    ["b", "d"],
    "workflow reports leave the uploads list, and the uploads keep their order",
  );

  // -- The refusal names people, never ids --------------------------------------------------------
  const one = describeWorkflowExpenseReportRefusal("deleted", ["Dina Hamdy Fadel Mohamed Bdair"]);
  assert.match(one, /submitted in the Phoenix app by Dina Hamdy Fadel Mohamed Bdair/);
  assert.match(one, /cannot be deleted here: deleting it would take that trip out of payroll/);
  assert.match(one, /Nothing was changed\./);
  assert.match(one, /changed on the Outstation queue/, "it says where an app trip IS changed");
  assert.doesNotMatch(one, /OUTSTATION\s*-|\.workflow|outstation-request|\b72\b|B-12/i, "names, never a trip id, request id, file name or HR id");

  const many = describeWorkflowExpenseReportRefusal(
    "replaced",
    ["Dina Hamdy Fadel Mohamed Bdair", "Ahmed Sharaf", " Dina Hamdy Fadel Mohamed Bdair ", ""],
    3,
  );
  assert.match(many, /3 outstation trips submitted in the Phoenix app by Ahmed Sharaf and Dina Hamdy Fadel Mohamed Bdair,/);
  assert.match(many, /cannot be replaced here: replacing it would take those trips out of payroll/);
  assert.equal(many.split("Dina Hamdy Fadel Mohamed Bdair").length - 1, 1, "each person once");

  const nobody = describeWorkflowExpenseReportRefusal("deleted", []);
  assert.match(nobody, /This is not an upload/, "an empty workflow report still gets a plain sentence");
  assert.doesNotMatch(nobody, / by /);
  for (const message of [one, many, nobody]) {
    assert.doesNotMatch(message, /…|\.\.\./, "never truncated with an ellipsis");
  }

  const refusal = new WorkflowExpenseReportProtectedError("deleted", ["Dina Hamdy Fadel Mohamed Bdair"]);
  assert.equal(isWorkflowExpenseReportProtected(refusal), true);
  assert.equal(refusal.message, one);
  assert.equal(isWorkflowExpenseReportProtected(new Error("x")), false);

  // -- Wiring the database round-trip cannot execute here -----------------------------------------
  const expenses = readFileSync("src/lib/outstation/expenses.ts", "utf8");
  const guard = body(
    expenses,
    "async function assertPayrollExpenseReportCanMutate(",
    "export async function deletePayrollExpenseReport(",
  );
  assert.match(guard, /planExpenseReportMutation\(\{\s*bypassPaidLock: canBypassPayrollExpenseLocks\(accessContext\),/, "the Super Admin bypass is an INPUT to the planner");
  assert.doesNotMatch(guard, /if \(canBypassPayrollExpenseLocks\(/, "never an early return that skips the workflow test");
  const refuse = guard.indexOf("throw new WorkflowExpenseReportProtectedError(");
  assert.ok(refuse > -1, "a workflow report is refused with the named error");
  assert.ok(refuse < guard.indexOf("throw new PayrollExpenseReportLockedError("), "before the paid lock");
  assert.ok(refuse < guard.indexOf("assertOutstationExpenseWorkflowTransition("), "and before the transition check");
  assert.match(guard, /\.from\("outstation_expense_reports"\)\s*\.select\("file_name"\)/, "reads the report's file name");
  const rowSelect = guard.match(/\.from\("outstation_expenses"\)\s*\.select\("([^"]+)"\)/);
  assert.ok(rowSelect, "reads the report's rows");
  const columns = new Set(rowSelect[1].split(","));
  for (const column of ["trip_id", "hr_id", "specialist", "hr_approved", "imported_payroll_batch_id", "imported_to_payroll_at"]) {
    assert.ok(columns.has(column), `the rows SELECT still carries ${column} — a narrowed select disarms the gate`);
  }

  for (const [name, action] of [
    ["deletePayrollExpenseReport", "deleted"],
    ["clearPayrollExpenseReportRows", "replaced"],
  ] as const) {
    const fn = body(expenses, `export async function ${name}(`, "\n}\n");
    const check = fn.indexOf(`await assertPayrollExpenseReportCanMutate(reportId, "${action}", accessContext);`);
    assert.ok(check > -1, `${name} runs the guard`);
    assert.ok(check < fn.indexOf(".delete()"), `${name} runs the guard before it deletes anything`);
  }

  const route = readFileSync("app/api/admin/outstation/expenses/reports/[id]/route.ts", "utf8");
  for (const [method, next] of [
    ["DELETE", "export async function PUT("],
    ["PUT", "\n}\n"],
  ] as const) {
    const handler = body(route, `export async function ${method}(`, next);
    assert.match(
      handler,
      /if \(isWorkflowExpenseReportProtected\(error\)\) \{\s*return NextResponse\.json\(\{ error: "workflow_expense_report", message \}, \{ status: 409 \}\);/,
      `${method} answers the refusal as a 409 carrying its message, not a 500`,
    );
  }
  const put = body(route, "export async function PUT(", "\n}\n");
  assert.ok(
    put.indexOf("clearPayrollExpenseReportRows(") < put.indexOf("savePayrollExpenseApprovals("),
    "Replace clears (and so refuses) before it saves the new sheet into the report",
  );

  const report = readFileSync("src/components/outstation/expense-report.tsx", "utf8");
  assert.match(report, /const uploadReports = useMemo\(\(\) => historicalUploadReports\(reports\), \[reports\]\);/);
  assert.match(report, /\{uploadReports\.length > 0 && \(/, "the uploads card counts uploads only");
  assert.match(report, /\{uploadReports\.slice\(0, 12\)\.map\(\(report\) => \(/, "and lists uploads only, so no Replace or Delete is offered on an app trip");
  assert.doesNotMatch(report, /\{reports\.slice\(|\{reports\.length > 0 &&|formatNumber\(reports\.length\)/);

  // The name the workflow writes and the name the guard reads come from one function.
  const service = readFileSync("src/lib/outstation/service.ts", "utf8");
  assert.doesNotMatch(service, /\.workflow`/, "service.ts never spells the workflow report name by hand");
  assert.equal(
    service.split("fileName: workflowExpenseReportFileName(").length - 1,
    3,
    "each of the workflow's three payroll pushes names its report through workflowExpenseReportFileName",
  );

  // -- The uploads list shows LIVE counts, so an emptied header is not a full look-alike -----------
  //
  // Production carried eight reports named `import` all reading the same stale "327 rows / EGP
  // 122,256" header while holding zero rows, beside the one `import` that actually held the ledger
  // (risk review of #4196, 2026-09-21). Reading the live rows is what stops a Super Admin deleting
  // the real one for a duplicate.
  const staleHeader = (overrides: Partial<PayrollExpenseReport>): PayrollExpenseReport => ({
    approvedRows: 310,
    createdAt: "2026-09-18T21:16:00.000Z",
    fileName: "import",
    id: "ledger",
    rowCount: 327,
    totalExpenses: 122256,
    tripDateFrom: null,
    tripDateTo: null,
    updatedAt: "2026-09-18T21:16:00.000Z",
    ...overrides,
  });

  const theLedger = staleHeader({ id: "ledger" });
  const anEmptyLookAlike = staleHeader({ id: "empty" });
  const countRow = (report_id: string, total: number, hr_approved: boolean) => ({ report_id, total, hr_approved });
  const counted = applyLiveExpenseReportCounts(
    [theLedger, anEmptyLookAlike],
    [
      countRow("ledger", 100, true),
      countRow("ledger", 56, false),
      countRow("ledger", 0, true),
    ],
  );

  assert.deepEqual(
    { rowCount: counted[0].rowCount, totalExpenses: counted[0].totalExpenses, approvedRows: counted[0].approvedRows },
    { rowCount: 3, totalExpenses: 156, approvedRows: 2 },
    "the report that holds rows reads its LIVE count, sum and approved tally, not the header",
  );
  assert.deepEqual(
    { rowCount: counted[1].rowCount, totalExpenses: counted[1].totalExpenses, approvedRows: counted[1].approvedRows },
    { rowCount: 0, totalExpenses: 0, approvedRows: 0 },
    "HEADLINE: an emptied report reads 0/0/0 however loudly its stored header still says 327",
  );
  assert.equal(counted[0].fileName, "import", "every other field, and the order, are untouched");
  assert.deepEqual(counted.map((report) => report.id), ["ledger", "empty"]);

  // A stray row with no report id is ignored rather than counted against a blank report.
  const orphan = applyLiveExpenseReportCounts([theLedger], [countRow("", 999, true)]);
  assert.equal(orphan[0].rowCount, 0, "a row carrying no report id counts toward nothing");

  // The admin uploads route feeds the list through the live count, not the stored header.
  const adminRoute = readFileSync("app/api/admin/outstation/expenses/route.ts", "utf8");
  assert.match(
    adminRoute,
    /const reports = await withLiveExpenseReportCounts\(await listPayrollExpenseReports\(access\)\);/,
    "the screen with the Delete button reads live report counts",
  );
}
