/**
 * Phoenix leave-request detail for the Company Activity Report — every v2_vacation_requests row
 * whose status is still "live" (mirrors private-calendar/service.ts's own loadVacationItems status
 * list exactly), expanded to every date it covers, with its REAL status kept (never collapsed to a
 * payroll-style approved/not) — owner ruling 2026-08-28: this is not a payroll report.
 *
 * Deliberately a single date-range scan with no employeeHrId filter pushed to the database (the
 * same shape company-vacation-report.ts already runs in production for the WHOLE company), rather
 * than a chunked `.in("employee_hr_id", …)` — this table is small enough that the proven full-scan
 * pattern is both simpler and safer: a mis-sized `.in()` chunk can silently return zero rows with
 * no error (see AGENTS.md's postgrest-in-with-hundreds-of-ids hard-learned rule), which is exactly
 * the class of silent gap this "must be accurate" report cannot afford. Matching against the
 * caller's roster happens in memory instead.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { listIsoDatesInRange } from "@/lib/attendance/working-days";
import type { CompanyActivityLeaveDetail } from "@/lib/company-activity-report/types";

/** The 5 non-terminal statuses this report shows, verbatim from
 * private-calendar/service.ts's loadVacationItems. Rejected/cancelled requests are deliberately
 * excluded — a request that never happened must never explain an absence. */
const LIVE_LEAVE_STATUSES = new Set(["needs_assignment", "pending_manager", "pending_hr", "approved", "submitted"]);

/** When two live requests cover the same employee-day, the more advanced one wins for display —
 * an edit/resubmission trail, not a real double booking. */
const STATUS_PRIORITY: Record<string, number> = {
  approved: 5,
  pending_hr: 4,
  pending_manager: 3,
  submitted: 2,
  needs_assignment: 1,
};

type LeaveRequestRow = {
  id: string;
  employee_hr_id: string | null;
  vacation_type: string | null;
  status: string | null;
  manager_decision: string | null;
  day_part: string | null;
  notes: string | null;
  start_date: string;
  end_date: string;
};

const LEAVE_DETAIL_COLUMNS =
  "id,employee_hr_id,vacation_type,status,manager_decision,day_part,notes,start_date,end_date";

/** Manager sign-off or HR approval — same "covered" rule loadVacationItems already applies, reused
 * rather than re-derived. */
function isCovered(row: LeaveRequestRow): boolean {
  return row.manager_decision === "approved" || row.status === "approved";
}

export async function loadCompanyActivityLeaveDetail(input: {
  dateFromIso: string;
  dateToIso: string;
}): Promise<Map<string, Map<string, CompanyActivityLeaveDetail>>> {
  const result = new Map<string, Map<string, CompanyActivityLeaveDetail>>();

  const { data, error } = await getSupabaseAdmin()
    .from("v2_vacation_requests")
    .select(LEAVE_DETAIL_COLUMNS)
    .lte("start_date", input.dateToIso)
    .gte("end_date", input.dateFromIso);
  if (error) throw new Error(`Failed to load leave requests: ${error.message}`);

  const rows = (data ?? []) as LeaveRequestRow[];
  for (const row of rows) {
    const status = (row.status ?? "").toLowerCase();
    if (!LIVE_LEAVE_STATUSES.has(status)) continue;
    const key = canonicalHrIdKey(row.employee_hr_id ?? "");
    if (!key) continue;

    const clampedStart = row.start_date > input.dateFromIso ? row.start_date : input.dateFromIso;
    const clampedEnd = row.end_date < input.dateToIso ? row.end_date : input.dateToIso;
    const coveredDates = listIsoDatesInRange(clampedStart, clampedEnd);
    if (coveredDates.length === 0) continue;

    const detail: CompanyActivityLeaveDetail = {
      id: row.id,
      vacationType: row.vacation_type,
      status: row.status ?? status,
      managerDecision: row.manager_decision,
      covered: isCovered(row),
      dayPart: row.day_part,
      notes: row.notes,
    };

    const byDate = result.get(key) ?? new Map<string, CompanyActivityLeaveDetail>();
    for (const dateIso of coveredDates) {
      const existing = byDate.get(dateIso);
      const existingPriority = existing ? STATUS_PRIORITY[(existing.status ?? "").toLowerCase()] ?? 0 : -1;
      if (!existing || (STATUS_PRIORITY[status] ?? 0) > existingPriority) {
        byDate.set(dateIso, detail);
      }
    }
    result.set(key, byDate);
  }

  return result;
}
