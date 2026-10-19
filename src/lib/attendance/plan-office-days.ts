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
// 🔴 TWO OWNER RULINGS DECIDE A DATE (2026-10-19), and both live in the pure resolver
// (plan-office-resolution.ts) so they are pinned on plain values:
//   · the APPROVED WEEKLY plan governs a date it covers; an approved monthly plan decides only a
//     date no weekly plan covers, and where the two disagree both are shown and the weekly plan is
//     followed. This lookup used to merge both kinds by "any Office wins", so a monthly Office day
//     overrode the weekly plan the person actually worked to.
//   · a HALF-day Office plan is HALF an office day: `officeHalf` names the half, and both the day
//     report and the fingerprint report (the deductions) judge only that half.
// Within the governing plan, an Office half still marks the day an office day — the employee was
// expected in the building for at least that half, so a punch should exist. On such a day a
// Meeting / Meeting with Team half counts as office too (owner, 2026-10-19), so Office + Meeting is
// a full office day; a meeting alone never makes one.
//
// A regional or national sales manager who plans his week in Phoenix CRM (owner,
// 2026-10-17) files no legacy plan any more, so his APPROVED Phoenix CRM week is
// read the same way, as a WEEKLY plan: an Office half-day marks the day office=true,
// any other half-day marks it false. Without it he would read "no plan" every day and
// stop being judged on the office days he still plans. A product manager files BOTH
// plans, and keeps being judged on his legacy one alone — exactly as before; a
// district manager plans no Office half and is not read here either.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import {
  isPlanMeetingActivity,
  resolvePlanOfficeDay,
  type PlanOfficeDay,
  type PlanOfficeEntry,
} from "@/lib/attendance/plan-office-resolution";
import { isIsoDate } from "@/lib/attendance/working-days";
import { logWarning } from "@/lib/observability/log";
import { loadManagerPlanHalfDays } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { planSlotFromTimes } from "@/lib/weekly-planning/plan-v1";

const approvedPlanStatuses = ["final_approved", "hr_acknowledged"] as const;

type PlanHeaderRow = {
  employee_hr_id: string;
  plan_kind: string | null;
  employee_plan_items: Array<{
    activity_date: string;
    activity_type: string | null;
    start_time: string | null;
    end_time: string | null;
  }> | null;
};

function isPlanSchemaMissing(error: unknown) {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return /employee_plan_headers|employee_plan_items|schema cache|does not exist|PGRST205|42P01/i.test(text);
}

/**
 * Map<employeeHrId, Map<dateIso, PlanOfficeDay>> built from approved weekly/monthly plans and the
 * approved Phoenix CRM manager weeks overlapping [dateFromIso, dateToIso]. Only dates an approved
 * plan covers are present — an absent date means "no plan for that day".
 * Degrades to an empty map (never throws) if the plan tables are unavailable, so
 * a Tier-2 digest fails closed (no plan data → gating treats it as "not an office
 * day" → skip, never a wrongful deduction).
 */
export async function getPlanOfficeDayDetailMap(input: {
  dateFromIso: string;
  dateToIso: string;
  employeeHrIds: string[];
}): Promise<Map<string, Map<string, PlanOfficeDay>>> {
  const detailByEmployee = new Map<string, Map<string, PlanOfficeDay>>();
  if (!isIsoDate(input.dateFromIso) || !isIsoDate(input.dateToIso)) return detailByEmployee;

  const normalizedHrIds = Array.from(
    new Set(input.employeeHrIds.map((id) => normalizeAttendanceHrId(id)).filter((value): value is string => Boolean(value))),
  );
  if (normalizedHrIds.length === 0) return detailByEmployee;

  const entriesByEmployee = new Map<string, Map<string, PlanOfficeEntry[]>>();
  const addEntry = (hrId: string, date: string, entry: PlanOfficeEntry) => {
    const byDate = entriesByEmployee.get(hrId) ?? new Map<string, PlanOfficeEntry[]>();
    byDate.set(date, [...(byDate.get(date) ?? []), entry]);
    entriesByEmployee.set(hrId, byDate);
  };

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_plan_headers")
    .select("employee_hr_id,plan_kind,employee_plan_items(activity_date,activity_type,start_time,end_time)")
    .in("employee_hr_id", normalizedHrIds)
    .in("status", approvedPlanStatuses)
    .lte("period_start_date", input.dateToIso)
    .gte("period_end_date", input.dateFromIso);

  if (error) {
    if (isPlanSchemaMissing(error)) return detailByEmployee;
    throw new Error(`Plan office-day lookup failed: ${error.message}`);
  }

  for (const header of (data ?? []) as PlanHeaderRow[]) {
    const hrId = normalizeAttendanceHrId(header.employee_hr_id);
    if (!hrId) continue;
    // Anything that is not a monthly plan is read as weekly — the governing kind — so an unexpected
    // value can never let a monthly plan overrule the week.
    const kind = header.plan_kind === "monthly" ? "monthly" : "weekly";
    for (const item of header.employee_plan_items ?? []) {
      if (!isIsoDate(item.activity_date)) continue;
      if (item.activity_date < input.dateFromIso || item.activity_date > input.dateToIso) continue;
      addEntry(hrId, item.activity_date, {
        kind,
        isOffice: item.activity_type === "Office",
        isMeeting: isPlanMeetingActivity(item.activity_type),
        slot: planSlotFromTimes(item.start_time, item.end_time),
      });
    }
  }

  // The regional and national sales managers' approved Phoenix CRM weeks, read as WEEKLY plans. A
  // failed read degrades like a missing plan table: his days read "no plan", which skips him —
  // never a wrongful deduction — and the legacy plans above still count.
  const halfDays = await loadManagerPlanHalfDays({
    from: input.dateFromIso,
    to: input.dateToIso,
    managerHrIds: normalizedHrIds,
    statuses: ["approved"],
    isTest: false,
    // Only the Office halves of a regional or national manager's week are read, never a customer.
    plannerKinds: ["rsm", "nsm"],
    customerCounts: false,
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
    addEntry(hrId, halfDay.date, {
      kind: "weekly",
      isOffice: halfDay.kind === "admin" && halfDay.activityType === "office",
      isMeeting: halfDay.kind === "admin" && halfDay.activityType === "meeting",
      slot: halfDay.half === "AM" ? "am" : "pm",
    });
  }

  for (const [hrId, byDate] of entriesByEmployee) {
    const resolved = new Map<string, PlanOfficeDay>();
    for (const [date, entries] of byDate) {
      const day = resolvePlanOfficeDay(entries);
      if (day) resolved.set(date, day);
    }
    if (resolved.size > 0) detailByEmployee.set(hrId, resolved);
  }
  return detailByEmployee;
}
