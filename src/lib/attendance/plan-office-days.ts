// Plan office/field day lookup for the Tier-2 (NSM/GPM/PM) digest gating.
//
// Reuses the existing weekly/monthly plan system (src/lib/weekly-planning):
// an approved plan's employee_plan_items carry an activity_type per date, and
// "Office" is the literal signal that a day is planned in-office. Any other
// activity type on an approved plan (Field, Double Visit, Meeting, Travel, ...)
// means the day is NOT planned in-office. A date with no approved-plan item at
// all is "no plan" (null) — the caller should treat that as "not an office day"
// per the confirmed spec (Tier 2 is judged ONLY on a plan-office day).
//
// If a day has more than one plan item (e.g. AM/PM split), any "Office" item
// that day marks it office=true — the employee was expected in the building at
// least part of the day, so a punch should exist.
//
// A regional or national sales manager who plans his week in Phoenix CRM (owner,
// 2026-10-17) files no legacy plan any more, so his APPROVED Phoenix CRM week is
// read the same way: an Office half-day marks the day office=true, any other
// half-day marks it false. Without it he would read "no plan" every day and stop
// being judged on the office days he still plans. A product manager files BOTH
// plans, and keeps being judged on his legacy one alone — exactly as before; a
// district manager plans no Office half and is not read here either.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { isIsoDate } from "@/lib/attendance/working-days";
import { logWarning } from "@/lib/observability/log";
import { loadManagerPlanHalfDays } from "@/lib/phoenix-crm/server/manager-plan-readers";

const approvedPlanStatuses = ["final_approved", "hr_acknowledged"] as const;

type PlanHeaderRow = {
  employee_hr_id: string;
  employee_plan_items: Array<{ activity_date: string; activity_type: string | null }> | null;
};

function isPlanSchemaMissing(error: unknown) {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return /employee_plan_headers|employee_plan_items|schema cache|does not exist|PGRST205|42P01/i.test(text);
}

/**
 * Map<employeeHrId, Map<dateIso, isOfficeDay>> built from approved weekly/monthly
 * plans overlapping [dateFromIso, dateToIso]. Only dates with an approved plan
 * item are present in the inner map — an absent date means "no plan for that day".
 * Degrades to an empty map (never throws) if the plan tables are unavailable, so
 * a Tier-2 digest fails closed (no plan data → gating treats it as "not an office
 * day" → skip, never a wrongful deduction).
 */
export async function getPlanOfficeDayMap(input: {
  dateFromIso: string;
  dateToIso: string;
  employeeHrIds: string[];
}): Promise<Map<string, Map<string, boolean>>> {
  const officeByEmployee = new Map<string, Map<string, boolean>>();
  if (!isIsoDate(input.dateFromIso) || !isIsoDate(input.dateToIso)) return officeByEmployee;

  const normalizedHrIds = Array.from(
    new Set(input.employeeHrIds.map((id) => normalizeAttendanceHrId(id)).filter((value): value is string => Boolean(value))),
  );
  if (normalizedHrIds.length === 0) return officeByEmployee;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_plan_headers")
    .select("employee_hr_id,employee_plan_items(activity_date,activity_type)")
    .in("employee_hr_id", normalizedHrIds)
    .in("status", approvedPlanStatuses)
    .lte("period_start_date", input.dateToIso)
    .gte("period_end_date", input.dateFromIso);

  if (error) {
    if (isPlanSchemaMissing(error)) return officeByEmployee;
    throw new Error(`Plan office-day lookup failed: ${error.message}`);
  }

  for (const header of (data ?? []) as PlanHeaderRow[]) {
    const hrId = normalizeAttendanceHrId(header.employee_hr_id);
    if (!hrId) continue;
    const byDate = officeByEmployee.get(hrId) ?? new Map<string, boolean>();

    for (const item of header.employee_plan_items ?? []) {
      if (!isIsoDate(item.activity_date)) continue;
      if (item.activity_date < input.dateFromIso || item.activity_date > input.dateToIso) continue;
      const isOffice = item.activity_type === "Office";
      // Any "Office" item that day wins over a non-office item on the same date.
      if (isOffice || !byDate.has(item.activity_date)) {
        byDate.set(item.activity_date, isOffice);
      }
    }

    if (byDate.size > 0) officeByEmployee.set(hrId, byDate);
  }

  // The regional and national sales managers' approved Phoenix CRM weeks, merged by the same
  // "any Office wins" rule. A failed read degrades like a missing plan table: his days read "no
  // plan", which skips him — never a wrongful deduction — and the legacy plans above still count.
  const halfDays = await loadManagerPlanHalfDays({
    from: input.dateFromIso,
    to: input.dateToIso,
    managerHrIds: normalizedHrIds,
    statuses: ["approved"],
    isTest: false,
  }).catch((crmError: unknown) => {
    logWarning("Plan office-day lookup could not read the Phoenix CRM manager weeks", {
      labels: { event: "plan_office_days_crm_manager_read_failed" },
      error: crmError,
    });
    return [];
  });
  for (const halfDay of halfDays) {
    if (halfDay.plannerKind !== "rsm" && halfDay.plannerKind !== "nsm") continue;
    const hrId = normalizeAttendanceHrId(halfDay.managerHrId);
    if (!hrId || !isIsoDate(halfDay.date)) continue;
    const byDate = officeByEmployee.get(hrId) ?? new Map<string, boolean>();
    const isOffice = halfDay.kind === "admin" && halfDay.activityType === "office";
    if (isOffice || !byDate.has(halfDay.date)) byDate.set(halfDay.date, isOffice);
    officeByEmployee.set(hrId, byDate);
  }

  return officeByEmployee;
}
