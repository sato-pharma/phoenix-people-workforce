// Approved excuse days for the weekly-digest reconciliation — mirrors
// getApprovedLeaveDayMap's shape but reads v2_excuse_requests (a single
// excuse_date per row, not a start/end range).

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { isIsoDate } from "@/lib/attendance/working-days";

type ExcuseRow = {
  employee_hr_id: string | null;
  excuse_date: string | null;
};

/**
 * Map<employeeHrId, Set<dateIso>> of approved excuses within the range.
 * Used to cancel an attendance deduction for a day covered by an approved
 * excuse (e.g. a permission slip), separate from full-day approved leave.
 */
export async function getApprovedExcuseDayMap(input: {
  dateFromIso: string;
  dateToIso: string;
  employeeHrIds?: string[];
}): Promise<Map<string, Set<string>>> {
  const excuseByEmployee = new Map<string, Set<string>>();
  if (!isIsoDate(input.dateFromIso) || !isIsoDate(input.dateToIso)) return excuseByEmployee;

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("v2_excuse_requests")
    .select("employee_hr_id,excuse_date")
    .eq("status", "approved")
    .gte("excuse_date", input.dateFromIso)
    .lte("excuse_date", input.dateToIso);

  const normalizedFilter = (input.employeeHrIds ?? [])
    .map((value) => normalizeAttendanceHrId(value))
    .filter((value): value is string => Boolean(value));
  if (normalizedFilter.length > 0) {
    query = query.in("employee_hr_id", normalizedFilter);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Approved excuse lookup failed: ${error.message}`);

  for (const row of (data ?? []) as ExcuseRow[]) {
    const hrId = normalizeAttendanceHrId(row.employee_hr_id);
    if (!hrId || !isIsoDate(row.excuse_date)) continue;
    const existing = excuseByEmployee.get(hrId) ?? new Set<string>();
    existing.add(row.excuse_date);
    excuseByEmployee.set(hrId, existing);
  }

  return excuseByEmployee;
}
