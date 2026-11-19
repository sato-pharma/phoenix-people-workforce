/**
 * THE HOLIDAY BRIDGING TAB'S ROW, AND THE DECISION IT POSTS BACK — one shape for the route and the screen.
 *
 * Why it exists (19 Nov 2026; money-integrity close-out §5 item 5, owner: "fix the Payroll Copilot Holiday Bridging
 * tab's Exclude and Include"). The route's GET built each row by hand and left `requestId` out, while the tab posted
 * `row.requestId` back with every Exclude and Include press — so every press answered 400 "requestId, employeeHrId,
 * and bridgingDate are required." and no exclusion could ever be recorded from the screen. The row the route sends
 * and the body the screen posts are now built here, from one type, so a field the decision needs cannot be dropped
 * from the row again without the test seeing it.
 *
 * Pure and import-free (the tab is a client component and must never pull the Supabase client in through
 * holiday-bridging.ts).
 */

/** What the Holiday Bridging tab reads for each row. */
export type HolidayBridgingScreenRow = {
  id: string;
  /** The approved vacation request the bridging day belongs to — the decision is recorded against it. */
  requestId: string;
  employeeHrId: string;
  employeeName: string | null;
  hireDate: string | null;
  vacationType: string;
  bridgingDate: string;
  adjacentTo: "before" | "after";
  holidayName: string;
  holidayStartDate: string;
  holidayEndDate: string;
  salaryDeductionAmount: number;
  excluded: boolean;
};

/** The fields of a domain candidate (listHolidayBridgingCandidates) the screen row is built from. */
export type HolidayBridgingCandidateFields = Omit<HolidayBridgingScreenRow, "hireDate">;

/** The row the route sends for one candidate: every field the screen shows and every field its decision posts. */
export function toHolidayBridgingScreenRow(
  candidate: HolidayBridgingCandidateFields,
  hireDate: string | null,
): HolidayBridgingScreenRow {
  return {
    id: candidate.id,
    requestId: candidate.requestId,
    employeeHrId: candidate.employeeHrId,
    employeeName: candidate.employeeName,
    hireDate,
    vacationType: candidate.vacationType,
    bridgingDate: candidate.bridgingDate,
    adjacentTo: candidate.adjacentTo,
    holidayName: candidate.holidayName,
    holidayStartDate: candidate.holidayStartDate,
    holidayEndDate: candidate.holidayEndDate,
    salaryDeductionAmount: candidate.salaryDeductionAmount,
    excluded: candidate.excluded,
  };
}

/** The two decisions the tab offers: Exclude a mandatory row, or Include an excluded one again. */
export type HolidayBridgingAction = "exclude" | "include";

/** What the tab posts for a row: the row's own identity, and the action that flips its current state. */
export function holidayBridgingDecisionBody(row: Pick<HolidayBridgingScreenRow, "requestId" | "employeeHrId" | "bridgingDate" | "excluded">): {
  requestId: string;
  employeeHrId: string;
  bridgingDate: string;
  action: HolidayBridgingAction;
} {
  return {
    requestId: row.requestId,
    employeeHrId: row.employeeHrId,
    bridgingDate: row.bridgingDate,
    action: row.excluded ? "include" : "exclude",
  };
}

/** The words the route answers a decision missing one of its three identifying fields with (400). */
export const HOLIDAY_BRIDGING_DECISION_FIELDS_REQUIRED = "requestId, employeeHrId, and bridgingDate are required.";

/** The decision's three identifying fields, trimmed; `null` when any is blank. */
export function readHolidayBridgingDecisionFields(body: {
  requestId?: string | null;
  employeeHrId?: string | null;
  bridgingDate?: string | null;
}): { requestId: string; employeeHrId: string; bridgingDate: string } | null {
  const requestId = String(body.requestId ?? "").trim();
  const employeeHrId = String(body.employeeHrId ?? "").trim();
  const bridgingDate = String(body.bridgingDate ?? "").trim();
  if (!requestId || !employeeHrId || !bridgingDate) return null;
  return { requestId, employeeHrId, bridgingDate };
}
