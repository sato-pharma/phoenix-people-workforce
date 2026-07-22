// Full calendar-day attendance detail for ONE employee over an arbitrary admin-chosen date
// range — every day in the range gets a row, not just the days that happened to produce a
// punch or a deduction. Reuses the exact same data sources and gating (reconcileDay) and math
// (evaluateFlexibleHoursDay) the weekly digest itself uses, just generalized off the digest's
// fixed weekly-cycle tiling so an admin can audit any employee/range on demand — owner rule
// 2026-07-21: "choose the HO employee from a droplist and choose a from date to to date and
// every day in this period is listed with its full details."
//
// Scoped to flex-eligible employees (resolved policy has required_minutes set) — the same
// population the digest engine governs. An employee not on that model returns tier: null and
// an empty days[] with a clear reason, rather than silently reusing a different formula here.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId, resolveActiveAttendancePolicy } from "@/lib/attendance/metrics";
import { loadAttendanceFlexPolicyGroups } from "@/lib/attendance/policy-groups";
import {
  buildAttendanceCalendarContext,
  classifyAttendanceDay,
  getApprovedLeaveDayMap,
  listIsoDatesInRange,
} from "@/lib/attendance/working-days";
import { getApprovedExcuseDayMap } from "@/lib/attendance/approved-excuse-days";
import { getCrmActivityDayMaps } from "@/lib/attendance/crm-day-maps";
import { getAttendanceExceptionMap } from "@/lib/attendance/exceptions";
import { getCompanyWideOutageDates } from "@/lib/attendance/ingestion-health";
import { getPlanOfficeDayMap } from "@/lib/attendance/plan-office-days";
import { loadEmployeeDayPunchMinutes } from "@/lib/attendance/punch-minutes";
import { reconcileDay, type AttendanceJudgmentMode } from "@/lib/attendance/digest-reconcile";
import {
  bracketsForEventType,
  evaluateFlexibleHoursDay,
  type AttendancePolicyRuleRow,
  type FlexibleHoursConfig,
} from "@/lib/attendance/flexible-hours";
import { validationError } from "@/lib/http/api-errors";
import { calculateDeductionAmountFromBaseSalary } from "@/lib/deductions-governance/calculations.ts";
import { getAttendanceRoster } from "@/lib/attendance/roster";
import { cairoTodayIso } from "@/lib/attendance/working-days";

export type FlexEligibleEmployeeOption = { hrId: string; employeeName: string; jobTitle: string };

/** The dropdown source for the day-by-day report — everyone flex-eligible (resolved policy has
 * required_minutes set) at some point across the given range, not the whole attendance-tracked
 * roster. Defaults to today/today so the dropdown is still populated before an admin has picked
 * a range — but once they have, callers should pass THAT range: an employee who resigned, or
 * whose policy moved off the flexible-hours model, since the period being reviewed must still be
 * selectable, or the historical review this report exists for is impossible for exactly them. */
export async function listFlexEligibleEmployees(range?: { dateFromIso: string; dateToIso: string }): Promise<FlexEligibleEmployeeOption[]> {
  const today = cairoTodayIso();
  const dateFromIso = range?.dateFromIso ?? today;
  const dateToIso = range?.dateToIso ?? today;
  const [roster, flexPolicies] = await Promise.all([
    getAttendanceRoster({ dateFromIso, dateToIso }),
    loadAttendanceFlexPolicyGroups({ activeOnly: true }),
  ]);
  const eligible: FlexEligibleEmployeeOption[] = [];
  for (const employee of roster) {
    const policy = resolveActiveAttendancePolicy({ hr_id: employee.hrId, job_title: employee.jobTitle }, flexPolicies, dateFromIso, dateToIso);
    if (policy && policy.required_minutes != null) {
      eligible.push({ employeeName: employee.employeeName, hrId: employee.hrId, jobTitle: employee.jobTitle });
    }
  }
  return eligible.sort((left, right) => left.employeeName.localeCompare(right.employeeName));
}

function timeToMinutes(value: string | null | undefined): number | null {
  const [hourText, minuteText] = String(value ?? "").slice(0, 5).split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return hour * 60 + minute;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function weekdayName(dateIso: string): string {
  return WEEKDAY_NAMES[new Date(`${dateIso}T00:00:00Z`).getUTCDay()];
}

export type EmployeeDayOutcome =
  | "weekly_off"
  | "holiday"
  | "approved_leave"
  | "approved_excuse"
  | "crm_leave"
  | "crm_field_visit"
  | "device_outage"
  | "office_no_show_flag"
  | "field_punch_anomaly_flag"
  | "no_plan_field_day"
  | "complete"
  | "late"
  | "short_hours"
  | "missing_punch"
  | "future"
  | "not_flex_eligible";

export type EmployeeDayReportRow = {
  dateIso: string;
  weekday: string;
  outcome: EmployeeDayOutcome;
  reason: string;
  firstPunchMinutes: number | null;
  lastPunchMinutes: number | null;
  visiblePunchCount: number;
  workedMinutes: number;
  lateMinutes: number;
  shortMinutes: number;
  deductionDays: number;
  deductionValue: number;
};

export type EmployeeDayByDayReport = {
  employeeHrId: string;
  employeeName: string;
  jobTitle: string;
  /** Null when this employee isn't on the flexible-hours model (required_minutes unset) — the
   * same "excepted" population the digest engine skips entirely. */
  tier: AttendanceJudgmentMode | null;
  dateFromIso: string;
  dateToIso: string;
  days: EmployeeDayReportRow[];
};

type EmployeeRow = { hr_id: string; full_name: string | null; job_title: string | null; base_salary: number | null };
type PolicyRuleDbRow = AttendancePolicyRuleRow & { deduction_value?: number | string | null };

export async function getEmployeeDayByDayReport(input: {
  employeeHrId: string;
  dateFromIso: string;
  dateToIso: string;
}): Promise<EmployeeDayByDayReport> {
  const hrId = normalizeAttendanceHrId(input.employeeHrId);
  if (!hrId) throw validationError("Invalid employee HR id.");
  if (input.dateFromIso > input.dateToIso) throw validationError("dateFrom must not be after dateTo.");

  const supabase = getSupabaseAdmin();

  // Fetched unfiltered and matched client-side by normalized HR_ID — the DB column's actual
  // casing is not guaranteed to match a pre-normalized .eq() filter.
  const [employeeResult, flexPolicies, ruleResult, context, leaveMap, excuseMap, exceptionMap, planMap, punchMap, outageDates, crmActivity] =
    await Promise.all([
      supabase.from("employees").select("hr_id,full_name,job_title,base_salary"),
      loadAttendanceFlexPolicyGroups({ activeOnly: true }),
      supabase
        .from("attendance_policy_rules")
        .select("policy_id,event_type,from_minutes,to_minutes,deduction_days,is_active")
        .eq("is_active", true),
      buildAttendanceCalendarContext({ dateFromIso: input.dateFromIso, dateToIso: input.dateToIso }),
      getApprovedLeaveDayMap({ dateFromIso: input.dateFromIso, dateToIso: input.dateToIso, employeeHrIds: [hrId] }),
      getApprovedExcuseDayMap({ dateFromIso: input.dateFromIso, dateToIso: input.dateToIso, employeeHrIds: [hrId] }),
      getAttendanceExceptionMap([hrId], input.dateFromIso, input.dateToIso),
      getPlanOfficeDayMap({ dateFromIso: input.dateFromIso, dateToIso: input.dateToIso, employeeHrIds: [hrId] }),
      loadEmployeeDayPunchMinutes({ dateFromIso: input.dateFromIso, dateToIso: input.dateToIso, employeeHrIds: [hrId] }),
      getCompanyWideOutageDates(input.dateFromIso, input.dateToIso),
      getCrmActivityDayMaps({ dateFromIso: input.dateFromIso, dateToIso: input.dateToIso, employeeHrIds: [hrId] }),
    ]);
  if (employeeResult.error) throw employeeResult.error;
  if (ruleResult.error) throw ruleResult.error;

  const employee = ((employeeResult.data ?? []) as EmployeeRow[]).find(
    (row) => normalizeAttendanceHrId(row.hr_id) === hrId,
  );
  if (!employee) throw validationError(`No employee found for ${input.employeeHrId}.`);

  const jobTitle = employee.job_title?.trim() ?? "";
  const employeeName = employee.full_name?.trim() || hrId;

  // Resolved PER DAY, not once for the whole admin-chosen range — an arbitrary range can
  // span a policy change (new scheduled_start/flex_minutes/required_minutes/brackets, or
  // the employee only became flex-eligible partway through). Derived per-policy values are
  // memoized by policy.id since the same policy typically governs many consecutive days.
  const rules = (ruleResult.data ?? []) as PolicyRuleDbRow[];
  type ResolvedDayPolicy = {
    policy: NonNullable<ReturnType<typeof resolveActiveAttendancePolicy<(typeof flexPolicies)[number]>>>;
    config: FlexibleHoursConfig;
    lateBrackets: ReturnType<typeof bracketsForEventType>;
    shortBrackets: ReturnType<typeof bracketsForEventType>;
  };
  const policyCache = new Map<number, ResolvedDayPolicy | null>();
  function resolvePolicyForDay(dateIso: string): ResolvedDayPolicy | null {
    const dayPolicy = resolveActiveAttendancePolicy(
      { hr_id: employee!.hr_id, job_title: employee!.job_title },
      flexPolicies,
      dateIso,
      dateIso,
    );
    if (!dayPolicy || dayPolicy.required_minutes == null) return null;
    const cached = policyCache.get(dayPolicy.id);
    if (cached !== undefined) return cached;
    const scheduledStartMinutes = timeToMinutes(dayPolicy.scheduled_start) ?? 9 * 60;
    const resolved: ResolvedDayPolicy = {
      config: {
        scheduledStartMinutes,
        flexCeilingMinutes: scheduledStartMinutes + (dayPolicy.flex_minutes ?? 0),
        requiredMinutes: dayPolicy.required_minutes,
      },
      lateBrackets: bracketsForEventType(rules, dayPolicy.id, "late"),
      policy: dayPolicy,
      shortBrackets: bracketsForEventType(rules, dayPolicy.id, "short_hours"),
    };
    policyCache.set(dayPolicy.id, resolved);
    return resolved;
  }

  const leaveDates = leaveMap.get(hrId) ?? new Set<string>();
  const excuseDates = excuseMap.get(hrId) ?? new Set<string>();
  const officeDates = planMap.get(hrId) ?? new Map<string, boolean>();
  const punches = punchMap.get(hrId) ?? new Map<string, { firstPunchMinutes: number | null; lastPunchMinutes: number | null; visiblePunchCount: number }>();
  const crmLeaveDates = crmActivity.leaveMap.get(hrId) ?? new Set<string>();
  const crmFieldVisitDates = crmActivity.fieldVisitMap.get(hrId) ?? new Set<string>();

  const days: EmployeeDayReportRow[] = [];
  let reportTier: AttendanceJudgmentMode | null = null;
  for (const dateIso of listIsoDatesInRange(input.dateFromIso, input.dateToIso)) {
    const punchInfo = punches.get(dateIso);
    const firstPunchMinutes = punchInfo?.firstPunchMinutes ?? null;
    const lastPunchMinutes = punchInfo?.lastPunchMinutes ?? null;
    const visiblePunchCount = punchInfo?.visiblePunchCount ?? 0;

    const dayPolicy = resolvePolicyForDay(dateIso);
    if (!dayPolicy) {
      // Not on the flexible-hours model on this specific date — never silently borrow a
      // policy from a different day's version to judge it (see the memoized resolver above).
      days.push(dayRow(dateIso, "not_flex_eligible", "Not on the flexible-hours model on this date.", firstPunchMinutes, lastPunchMinutes, visiblePunchCount));
      continue;
    }
    reportTier = dayPolicy.policy.judgment_mode;
    const { config, lateBrackets, shortBrackets } = dayPolicy;

    const classification = classifyAttendanceDay({ context, dateIso, jobTitle, workingWeekdays: dayPolicy.policy.working_weekdays });
    const hasApprovedException = exceptionMap.get(`${hrId}|${dateIso}`)?.status === "approved";

    if (classification.isFuture) {
      days.push(dayRow(dateIso, "future", "In the future.", firstPunchMinutes, lastPunchMinutes, visiblePunchCount));
      continue;
    }

    const hasApprovedLeaveToday = leaveDates.has(dateIso) || hasApprovedException;
    const hasExcuseToday = excuseDates.has(dateIso);
    const hasCrmLeaveToday = crmLeaveDates.has(dateIso);
    const hasCrmFieldVisitToday = crmFieldVisitDates.has(dateIso);
    const hasOutageToday = outageDates.has(dateIso);

    const decision = reconcileDay({
      deviceOutage: hasOutageToday,
      hasApprovedExcuse: hasExcuseToday,
      hasApprovedLeave: hasApprovedLeaveToday,
      hasCrmFieldVisit: hasCrmFieldVisitToday,
      hasCrmLeave: hasCrmLeaveToday,
      hasPunch: visiblePunchCount > 0,
      isHoliday: classification.isHoliday,
      isWorkingDay: !classification.isWeeklyOff,
      planSaysOffice: officeDates.get(dateIso) ?? null,
      tier: dayPolicy.policy.judgment_mode,
    });

    if (decision.action === "skip") {
      // Same precedence reconcileDay itself uses (see digest-reconcile.ts), re-derived from
      // the same booleans just passed in — never parsed from decision.reason, which is
      // display text, not a branching key.
      const outcome: EmployeeDayOutcome = classification.isWeeklyOff
        ? "weekly_off"
        : classification.isHoliday
          ? "holiday"
          : hasApprovedLeaveToday
            ? "approved_leave"
            : hasExcuseToday
              ? "approved_excuse"
              : hasCrmLeaveToday
                ? "crm_leave"
                : hasCrmFieldVisitToday
                  ? "crm_field_visit"
                  : hasOutageToday
                    ? "device_outage"
                    : "no_plan_field_day"; // remaining office_days_only skip branches (field-per-plan / no-plan-designated)
      days.push(dayRow(dateIso, outcome, decision.reason, firstPunchMinutes, lastPunchMinutes, visiblePunchCount));
      continue;
    }

    if (decision.action === "flag") {
      days.push(dayRow(
        dateIso,
        decision.flagType === "office_no_show" ? "office_no_show_flag" : "field_punch_anomaly_flag",
        decision.reason,
        firstPunchMinutes,
        lastPunchMinutes,
        visiblePunchCount,
      ));
      continue;
    }

    // "judge" — run the exact same math the digest engine settles from.
    const result = evaluateFlexibleHoursDay({
      config,
      firstPunchMinutes,
      lastPunchMinutes,
      lateBrackets,
      shortBrackets,
      visiblePunchCount,
    });
    const outcome: EmployeeDayOutcome =
      result.status === "Complete" ? "complete"
      : result.status === "Late" ? "late"
      : result.status === "Short hours" ? "short_hours"
      : "missing_punch";
    const deductionValue = result.deductionDays > 0
      ? calculateDeductionAmountFromBaseSalary({ baseSalary: employee.base_salary ?? 0, deductionDays: result.deductionDays }) ?? 0
      : 0;
    days.push({
      dateIso,
      deductionDays: result.deductionDays,
      deductionValue,
      firstPunchMinutes,
      lastPunchMinutes,
      lateMinutes: result.lateMinutes,
      outcome,
      reason: result.reason,
      shortMinutes: result.shortMinutes,
      visiblePunchCount,
      weekday: weekdayName(dateIso),
      workedMinutes: firstPunchMinutes != null && lastPunchMinutes != null ? Math.max(0, lastPunchMinutes - firstPunchMinutes) : 0,
    });
  }

  // Null only when NO day in the range resolved a flex policy at all — the same "isn't on the
  // flexible-hours model" case the caller already handles. A range that's flex-eligible for
  // only part of its span still returns a real tier plus a per-day mix of judged rows and
  // not_flex_eligible rows for the rest.
  return { dateFromIso: input.dateFromIso, dateToIso: input.dateToIso, days, employeeHrId: hrId, employeeName, jobTitle, tier: reportTier };
}

function dayRow(
  dateIso: string,
  outcome: EmployeeDayOutcome,
  reason: string,
  firstPunchMinutes: number | null,
  lastPunchMinutes: number | null,
  visiblePunchCount: number,
): EmployeeDayReportRow {
  return {
    dateIso,
    deductionDays: 0,
    deductionValue: 0,
    firstPunchMinutes,
    lastPunchMinutes,
    lateMinutes: 0,
    outcome,
    reason,
    shortMinutes: 0,
    visiblePunchCount,
    weekday: weekdayName(dateIso),
    workedMinutes: firstPunchMinutes != null && lastPunchMinutes != null ? Math.max(0, lastPunchMinutes - firstPunchMinutes) : 0,
  };
}

