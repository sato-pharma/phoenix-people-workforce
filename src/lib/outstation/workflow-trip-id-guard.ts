/**
 * A SHEET MAY NEVER WRITE AN APP TRIP'S PAYROLL ROW.
 *
 * `outstation_expenses` holds two kinds of row under one `trip_id` unique key: trips imported from a
 * historical Excel sheet, and the payroll row the outstation workflow writes for a trip submitted in
 * the Phoenix app, keyed `OUTSTATION-<request id>` (`outstationPayrollTripId`). Every save upserts on
 * `trip_id`, so a sheet row whose TripID cell reads `OUTSTATION-72` does not add a row — it lands ON
 * request 72's payroll row and overwrites its travel, meeting, allowance, other and total, its AM/PM
 * workload, and its `report_id` (moving the trip into the uploaded report, where deleting that upload
 * would delete the app trip's payroll row with it).
 *
 * That sheet is easy to make by accident. The admin Expense Approvals export (header "Trip ID") and
 * the report screen's template download (header "TripID") both list app trips next to imported ones,
 * and the importer accepts the admin export as the Phoenix template: on 2026-09-21 a re-upload of it
 * parsed with zero errors, and every app trip in it came back with its workload read as 0 (the export
 * says "Declared AM"/"Declared PM", which the importer does not read) and its "Other" amount dropped.
 *
 * So the `OUTSTATION-` prefix is RESERVED to the workflow. The importer refuses a sheet carrying one
 * (`analyzeExpenseWorkbook` — before the replace path clears anything), and the save itself refuses
 * one unless the caller is the workflow's own push (`savePayrollExpenseApprovals`'s
 * `allowWorkflowTripIds`), so a future caller that skips the importer cannot reopen the hole.
 *
 * OWNER DECISION, 2026-09-21: the WHOLE sheet is refused, never a partial import that skips the app
 * trips and saves the rest. Do not "soften" it into a skip. The refused rows stay on screen so HR can
 * see what to delete, and the Save button stays locked on them (`expense-report.tsx`,
 * `expenses-review-workspace.tsx`): Save posts to the approvals route, which would otherwise import the
 * refused sheet through a second door and re-decide its app trips with the sheet's defaults. The
 * approvals route also refuses a reserved-but-not-exact id BEFORE it commits any request decision.
 *
 * Measured on production (ozucdzovmcqvepbozvqf) the same day: 80 rows carry the prefix, every one
 * written by the workflow (its `outstation-request-<id>.workflow` file name matches its trip id), and
 * none of the 327 sheet-imported rows does — so refusing the prefix blocks no real historical data.
 */

import { OUTSTATION_REQUEST_TRIP_PREFIX } from "@/lib/outstation/expense-approval-decisions";

/**
 * True when a trip id sits in the workflow's reserved namespace.
 *
 * Deliberately WIDER than `outstationRequestIdFromTripId`: that one decides which request a queue row
 * belongs to and must be strict, while this one decides what a sheet may not write, so it ignores case
 * and spacing. `outstation-72` or `OUTSTATION - 72` would not collide with request 72's row, but they
 * would plant a second row that reads as that trip, and no real sheet row has ever used the prefix.
 */
export function isWorkflowTripId(tripId: unknown): boolean {
  const compact = String(tripId ?? "").replace(/\s+/g, "").toUpperCase();
  return compact.startsWith(OUTSTATION_REQUEST_TRIP_PREFIX);
}

export type WorkflowTripIdRow = {
  /** The sheet row number, as the importer counts it (the header row is not row 1 of the data). */
  row: number;
  /** The employee name as the sheet has it — what the uploader can find the row by. */
  specialist: string;
};

type TripRecordLike = {
  row?: number | null;
  specialist?: string | null;
  tripId?: string | null;
};

export function findRowsCarryingWorkflowTripIds(
  records: ReadonlyArray<TripRecordLike>,
): WorkflowTripIdRow[] {
  return records
    .filter((record) => isWorkflowTripId(record.tripId))
    .map((record) => ({
      row: Number(record.row ?? 0),
      specialist: String(record.specialist ?? "").trim(),
    }));
}

function displayName(specialist: string) {
  return specialist && specialist.toLowerCase() !== "unassigned" ? specialist : "No employee name";
}

/**
 * The refusal the uploader reads. Names the people and the sheet rows, never the trip ids (owner rule:
 * names, never codes), and every row, never a truncated list. It says DELETE the row, never "clear the
 * Trip ID": a blank TripID is given a new synthetic id, which would import the same app trip as a
 * second payable row.
 */
export function describeWorkflowTripIdRefusal(rows: ReadonlyArray<WorkflowTripIdRow>): string {
  const byPerson = new Map<string, number[]>();
  for (const entry of rows) {
    const name = displayName(entry.specialist);
    const list = byPerson.get(name) ?? [];
    list.push(entry.row);
    byPerson.set(name, list);
  }

  const people = Array.from(byPerson.entries())
    .map(([name, rowNumbers]) => {
      const sorted = [...rowNumbers].sort((left, right) => left - right);
      return `${name} (${sorted.length === 1 ? "row" : "rows"} ${sorted.join(", ")})`;
    })
    .join("; ");

  const count = rows.length;
  return (
    `This sheet was not imported: ${count} ${count === 1 ? "row belongs" : "rows belong"} to ` +
    `${count === 1 ? "a trip" : "trips"} submitted in the Phoenix app, and uploading ` +
    `${count === 1 ? "it would overwrite that trip's" : "them would overwrite those trips'"} payroll figures. ` +
    `Delete ${count === 1 ? "that row" : "those rows"} from the sheet and upload it again — an app ` +
    `trip is changed on the Outstation queue, never by a sheet. A file downloaded from Phoenix is ` +
    `never uploaded back at all: every row in it is already here. ${people}.`
  );
}

export class WorkflowTripIdRefusedError extends Error {
  readonly rows: WorkflowTripIdRow[];

  constructor(rows: WorkflowTripIdRow[]) {
    super(describeWorkflowTripIdRefusal(rows));
    this.name = "WorkflowTripIdRefusedError";
    this.rows = rows;
  }
}

/** Throws before anything is written when a save that is not the workflow carries a reserved id. */
export function assertNoWorkflowTripIds(records: ReadonlyArray<TripRecordLike>): void {
  const rows = findRowsCarryingWorkflowTripIds(records);
  if (rows.length > 0) throw new WorkflowTripIdRefusedError(rows);
}
