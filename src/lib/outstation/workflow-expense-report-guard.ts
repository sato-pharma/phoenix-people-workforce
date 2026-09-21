/**
 * AN APP TRIP'S PAYROLL REPORT IS NOT AN UPLOAD, AND THE UPLOADS LIST MAY NEVER DELETE OR REPLACE IT.
 *
 * `outstation_expense_reports` holds two kinds of report. A real upload is one historical Excel sheet
 * and its rows. The outstation workflow also mints one report per trip submitted in the Phoenix app,
 * named `outstation-request-<id>.workflow`, holding that trip's single payroll row
 * (`OUTSTATION-<id>`, see `outstationPayrollTripId`). Both used to sit on the admin Outstation
 * expenses screen under "Historical Outstation Uploads", each with Replace and Delete.
 *
 * Both actions remove EVERY `outstation_expenses` row carrying the report's id
 * (`deletePayrollExpenseReport`, `clearPayrollExpenseReportRows`). On a workflow report that row is
 * the app trip's payroll record, so one click took an accepted trip out of payroll while its request
 * still read accepted — and nothing else moved: the request was not reopened, the payroll Expenses
 * step was not resynced (the workflow's own reject and delete paths do both), and Replace with a clean
 * sheet slipped past the `OUTSTATION-` trip id guard because the new sheet carries no reserved id. The
 * only lock was the paid stamp, which none of these rows carry until payroll runs, and which a Super
 * Admin bypasses anyway.
 *
 * Measured on production (ozucdzovmcqvepbozvqf) on 2026-09-21: 83 of the 94 reports were named
 * `.workflow`. 80 of them held exactly one app-trip row each (78 approved, none paid-stamped), 3 were
 * empty, and every file name matched its own row's trip id. The 11 real uploads held 327 rows, none
 * of them an app trip.
 *
 * WHICH REPORT IS A WORKFLOW REPORT — either test is enough:
 *   1. its file name ends `.workflow`. Only the workflow writes that suffix (`workflowExpenseReportFileName`,
 *      used by all three of its pushes in service.ts), and both upload routes accept `.xlsx` only.
 *      This is the test that catches an EMPTY workflow report, which has no rows to read.
 *   2. ANY row in it carries a workflow trip id (`isWorkflowTripId`). The file name alone is not
 *      robust: `savePayrollExpenseApprovals` rewrites the `file_name` of whatever report it saves into,
 *      so a report can lose its `.workflow` name while the app trip's row is still inside it — and
 *      before the trip id guard, a sheet row could move an app trip INTO an upload's report. "Any row",
 *      not "every row": every-row is vacuously true for an empty upload (10 on production) and false
 *      for a mixed one, which is exactly the report whose delete would take an app trip with it.
 *
 * The refusal runs for EVERY role, Super Admin included, and before the paid-stamp lock: the Super
 * Admin bypass exists to let him clear a paid historical upload, never to delete an app trip's payroll
 * row from the wrong screen. An app trip is changed on the Outstation queue, where rejecting or
 * deleting it also reopens what it must and resyncs payroll.
 *
 * The uploads list hides workflow reports rather than showing them without buttons
 * (`historicalUploadReports`): they are not uploads, their only label is a file name built from a
 * request id (owner rule: names, never ids), and every one of those trips is already on the queue by
 * the employee's name. The new claims model already treats them the same way — `expense_claims`
 * points only at the real uploads (see the note in `listUnifiedOutstationExpenses`).
 */

import { isWorkflowTripId } from "@/lib/outstation/workflow-trip-id-guard";

/** The suffix only the outstation workflow gives the report it mints for an app trip. */
export const WORKFLOW_EXPENSE_REPORT_SUFFIX = ".workflow";

/**
 * The file name of the report the workflow mints for request `<id>`. The ONE place the name is built,
 * so the name and `isWorkflowExpenseReportFileName` cannot drift apart.
 */
export function workflowExpenseReportFileName(requestId: string | number): string {
  return `outstation-request-${requestId}${WORKFLOW_EXPENSE_REPORT_SUFFIX}`;
}

/** True when a report's file name marks it as the workflow's own (test 1 above). */
export function isWorkflowExpenseReportFileName(fileName: unknown): boolean {
  return String(fileName ?? "").trim().toLowerCase().endsWith(WORKFLOW_EXPENSE_REPORT_SUFFIX);
}

type TripRowLike = { trip_id?: unknown };

/** The rows in a report that are an app trip's payroll record (test 2 above). */
export function appTripRowsInReport<T extends TripRowLike>(rows: ReadonlyArray<T>): T[] {
  return rows.filter((row) => isWorkflowTripId(row.trip_id));
}

/** True when a report is the workflow's, by either test. */
export function isWorkflowExpenseReport(input: {
  fileName: unknown;
  rows: ReadonlyArray<TripRowLike>;
}): boolean {
  return isWorkflowExpenseReportFileName(input.fileName) || appTripRowsInReport(input.rows).length > 0;
}

/** The reports the "Historical Outstation Uploads" list may show: real uploads only, order kept. */
export function historicalUploadReports<T extends { fileName: string }>(reports: ReadonlyArray<T>): T[] {
  return reports.filter((report) => !isWorkflowExpenseReportFileName(report.fileName));
}

export type ExpenseReportMutationAction = "deleted" | "replaced";

type ExpenseReportLockRow = TripRowLike & {
  hr_approved?: unknown;
  imported_payroll_batch_id?: unknown;
  imported_to_payroll_at?: unknown;
};

export type ExpenseReportMutationPlan<T> =
  /** A workflow report. Refused for every role; the rows are the app trips to name. */
  | { appTripRows: T[]; outcome: "workflow_report" }
  /** A row is already in a paid payroll batch, and the caller cannot bypass that lock. */
  | { outcome: "paid" }
  /**
   * May go ahead. `transitionFrom` is the workflow status to check the delete against, or null when
   * the caller bypasses the payroll locks (a Super Admin skips that check, exactly as before).
   */
  | { outcome: "allowed"; transitionFrom: "approved" | "pending" | null };

/**
 * Decides whether an uploads-list Delete or Replace may touch a report — pure, so the order of the
 * checks is testable without the database. The workflow test comes FIRST, before the bypass.
 */
export function planExpenseReportMutation<T extends ExpenseReportLockRow>(input: {
  bypassPaidLock: boolean;
  fileName: unknown;
  rows: ReadonlyArray<T>;
}): ExpenseReportMutationPlan<T> {
  if (isWorkflowExpenseReport({ fileName: input.fileName, rows: input.rows })) {
    return { appTripRows: appTripRowsInReport(input.rows), outcome: "workflow_report" };
  }

  if (input.bypassPaidLock) return { outcome: "allowed", transitionFrom: null };

  const paid = input.rows.some(
    (row) => row.imported_payroll_batch_id != null || row.imported_to_payroll_at != null,
  );
  if (paid) return { outcome: "paid" };

  return {
    outcome: "allowed",
    transitionFrom: input.rows.some((row) => Boolean(row.hr_approved)) ? "approved" : "pending",
  };
}

function joinNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The refusal the admin reads. Names the employees, every one of them, never a trip id, request id or
 * file name (owner rule: names, never codes), and says where an app trip IS changed.
 */
export function describeWorkflowExpenseReportRefusal(
  action: ExpenseReportMutationAction,
  employeeNames: ReadonlyArray<string>,
  tripCount = employeeNames.length,
): string {
  const verb = action === "deleted" ? "deleting" : "replacing";
  const names = Array.from(new Set(employeeNames.map((name) => name.trim()).filter(Boolean))).sort(
    (left, right) => left.localeCompare(right),
  );
  const where = "An app trip is changed on the Outstation queue, never from the uploads list.";

  if (names.length === 0) {
    return (
      `This is not an upload: the Phoenix app keeps this record for an outstation trip submitted in ` +
      `the app, so it cannot be ${action} here. Nothing was changed. ${where}`
    );
  }

  const trips = Math.max(tripCount, 1);
  const what =
    trips === 1
      ? "the payroll record of an outstation trip"
      : `the payroll records of ${trips} outstation trips`;
  const those = trips === 1 ? "that trip" : "those trips";
  const their = trips === 1 ? "its request" : "their requests";
  return (
    `This report holds ${what} submitted in the Phoenix app by ${joinNames(names)}, so it cannot be ` +
    `${action} here: ${verb} it would take ${those} out of payroll, and ${their} on the Outstation ` +
    `queue would not change. Nothing was changed. ${where}`
  );
}

export class WorkflowExpenseReportProtectedError extends Error {
  readonly action: ExpenseReportMutationAction;
  readonly employeeNames: string[];

  constructor(action: ExpenseReportMutationAction, employeeNames: string[], tripCount = employeeNames.length) {
    super(describeWorkflowExpenseReportRefusal(action, employeeNames, tripCount));
    this.name = "WorkflowExpenseReportProtectedError";
    this.action = action;
    this.employeeNames = employeeNames;
  }
}

export function isWorkflowExpenseReportProtected(error: unknown): error is WorkflowExpenseReportProtectedError {
  return error instanceof WorkflowExpenseReportProtectedError;
}
