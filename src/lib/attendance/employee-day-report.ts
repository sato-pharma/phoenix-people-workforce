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
import { describeReconcileSkip, reconcileDay, type AttendanceJudgmentMode } from "@/lib/attendance/digest-reconcile";
import {
  bracketsForEventType,
  evaluateFlexibleHoursDay,
  type AttendancePolicyRuleRow,
  type FlexibleHoursConfig,
} from "@/lib/attendance/flexible-hours";
import { validationError } from "@/lib/http/api-errors";
// The DEDUCTIONS implementation (Base ÷ ACTUAL calendar days), not the
// deductions-governance one that divides by a flat 30.
//
// 🔴 THERE ARE TWO FUNCTIONS WITH THIS NAME. They differ only in the divisor, and the
// ÷30 version takes no month at all — so calling the wrong one is invisible: it type-checks
// perfectly and simply produces a different number. This file imported the ÷30 version, so
// every fingerprint deduction ignored the owner's standing "day rate = Base ÷ actual
// calendar days, EVERYWHERE" rule while every other category honoured it.
//
// Measured on July 2026 production (31 days): Ali Mohamed Ali 90,000 ÷ 30 × 2.13 = 6,390.00
// where ÷31 gives 6,183.87; Ahmed El Maraghy 37,500 ÷ 30 × 3.26 = 4,075.00. Across the
// category that over-charged ~3.3% (~789 EGP of 24,460.21) — and would UNDER-charge 6.7%
// in February, so it is wrong in both directions, not merely conservative.
//
// deductions-governance/calculations.ts keeps its ÷30 deliberately: it still feeds the
// legacy governance module and Automated Payroll, which are out of scope here.
import { calculateDeductionAmountFromBaseSalary } from "@/lib/deductions/calculations.ts";
import { getAttendanceRoster } from "@/lib/attendance/roster";
import { cairoTodayIso } from "@/lib/attendance/working-days";
import { buildDeductionCandidateKey } from "@/lib/deductions-governance/candidate-key.ts";
import { insertDeductionCandidateDrafts, listDeductionCandidates, recordCopilotDeductionDecision } from "@/lib/deductions-governance/service.ts";
import type { DeductionCandidateDraft, DeductionDecision, DeductionType } from "@/lib/deductions-governance/types.ts";
import { systemAccessContext } from "@/lib/auth/permissions";
import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";

export type FlexEligibleEmployeeOption = { hrId: string; employeeName: string; jobTitle: string };

/** Every employee carrying at least one live (non-superseded) ATTENDANCE_DEVICE deduction
 * candidate, regardless of their CURRENT attendance-policy resolution. Confirmed real case
 * 2026-07-24: an employee can have an always-active per-employee policy override
 * (required_minutes: null) that predates a deduction candidate the now-retired weekly digest
 * created for them anyway — once that override is in place, listFlexEligibleEmployees's normal
 * roster/policy scan can never resolve them again, so without this union that candidate becomes
 * permanently unreachable from this report (no way to open, confirm, or reject it) even though
 * it may already be "Approved for Payroll". Independent of the roster/date-range scan above; a
 * small table, so this is a cheap full scan rather than trying to thread a date range through it. */
async function listEmployeesWithOutstandingAttendanceCandidates(): Promise<FlexEligibleEmployeeOption[]> {
  const supabase = getSupabaseAdmin();
  const { data: candidateRows, error: candidateError } = await supabase
    .from("deduction_candidates")
    .select("employee_code")
    .eq("source_module", "ATTENDANCE_DEVICE")
    .is("superseded_at", null);
  if (candidateError) throw candidateError;
  const wanted = new Set(
    ((candidateRows ?? []) as Array<{ employee_code: string | null }>)
      .map((row) => normalizeAttendanceHrId(row.employee_code))
      .filter((value): value is string => Boolean(value)),
  );
  if (wanted.size === 0) return [];

  const { data: employeeRows, error: employeeError } = await supabase.from("employees").select("hr_id,full_name,job_title");
  if (employeeError) throw employeeError;
  const result: FlexEligibleEmployeeOption[] = [];
  for (const row of (employeeRows ?? []) as Array<{ hr_id: string; full_name: string | null; job_title: string | null }>) {
    const hrId = normalizeAttendanceHrId(row.hr_id);
    if (!hrId || !wanted.has(hrId)) continue;
    result.push({ employeeName: row.full_name?.trim() || hrId, hrId, jobTitle: row.job_title?.trim() ?? "" });
  }
  return result;
}

/** The dropdown source for the day-by-day report — everyone flex-eligible (resolved policy has
 * required_minutes set) at some point across the given range, not the whole attendance-tracked
 * roster. Defaults to today/today so the dropdown is still populated before an admin has picked
 * a range — but once they have, callers should pass THAT range: an employee who resigned, or
 * whose policy moved off the flexible-hours model, since the period being reviewed must still be
 * selectable, or the historical review this report exists for is impossible for exactly them.
 * ALSO always includes anyone with an outstanding ATTENDANCE_DEVICE candidate (see
 * listEmployeesWithOutstandingAttendanceCandidates) so an already-created deduction is never
 * stranded behind a policy change that excludes them from the roster/policy scan. */
export async function listFlexEligibleEmployees(range?: { dateFromIso: string; dateToIso: string }): Promise<FlexEligibleEmployeeOption[]> {
  const today = cairoTodayIso();
  const dateFromIso = range?.dateFromIso ?? today;
  const dateToIso = range?.dateToIso ?? today;
  const [roster, flexPolicies, outstanding] = await Promise.all([
    getAttendanceRoster({ dateFromIso, dateToIso }),
    loadAttendanceFlexPolicyGroups({ activeOnly: true }),
    listEmployeesWithOutstandingAttendanceCandidates(),
  ]);
  const eligible = new Map<string, FlexEligibleEmployeeOption>();
  for (const employee of roster) {
    const policy = resolveActiveAttendancePolicy({ hr_id: employee.hrId, job_title: employee.jobTitle }, flexPolicies, dateFromIso, dateToIso);
    if (policy && policy.required_minutes != null) {
      eligible.set(employee.hrId, { employeeName: employee.employeeName, hrId: employee.hrId, jobTitle: employee.jobTitle });
    }
  }
  for (const employee of outstanding) {
    if (!eligible.has(employee.hrId)) eligible.set(employee.hrId, employee);
  }
  return Array.from(eligible.values()).sort((left, right) => left.employeeName.localeCompare(right.employeeName));
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
  /** For live-recalculating a day's EGP value client-side as its deduction days are edited —
   * same base/30 x days formula the server always re-derives on Approve, so an edited display
   * value can never drift from what actually gets saved. */
  baseSalary: number | null;
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
  const crmDetailDates = crmActivity.detailMap.get(hrId) ?? new Map<string, string>();

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
      const outcome: EmployeeDayOutcome = describeReconcileSkip({
        hasApprovedExcuse: hasExcuseToday,
        hasApprovedLeave: hasApprovedLeaveToday,
        hasCrmFieldVisit: hasCrmFieldVisitToday,
        hasCrmLeave: hasCrmLeaveToday,
        hasOutage: hasOutageToday,
        isHoliday: classification.isHoliday,
        isWeeklyOff: classification.isWeeklyOff,
      });
      // For a CRM-covered day, surface WHAT was logged (visit type + comment/customer) rather than
      // just the generic gating text — otherwise "CRM field visit" reads as an opaque boolean and
      // an admin reviewing the day has no way to see the actual meeting/visit that covered it.
      const crmDetail = outcome === "crm_field_visit" || outcome === "crm_leave" ? crmDetailDates.get(dateIso) : null;
      const reason = crmDetail ? `${decision.reason} — ${crmDetail}` : decision.reason;
      days.push(dayRow(dateIso, outcome, reason, firstPunchMinutes, lastPunchMinutes, visiblePunchCount));
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
      ? calculateDeductionAmountFromBaseSalary({
          baseSalary: employee.base_salary ?? 0,
          deductionDays: result.deductionDays,
          // The day being charged decides the divisor, so a month-boundary range
          // cannot bill January days at February's rate.
          month: Number(dateIso.slice(5, 7)),
          year: Number(dateIso.slice(0, 4)),
        }) ?? 0
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
  return {
    baseSalary: employee.base_salary ?? null,
    dateFromIso: input.dateFromIso,
    dateToIso: input.dateToIso,
    days,
    employeeHrId: hrId,
    employeeName,
    jobTitle,
    tier: reportTier,
  };
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

// ---------------------------------------------------------------------------
// Deduction decisions — this report is the ONE place an admin confirms/rejects
// a day's fingerprint deduction (the standalone Fingerprint Deductions page
// was retired in favor of deciding right here, per owner direction 2026-07-24).
// Reuses the SAME deduction_candidates/deduction_decisions rows and
// ATTENDANCE_DEVICE source module Automated Payroll's Part 1 step already
// reads via listFingerprintDeductionCandidates — a candidate created here is
// created on demand (this report never bulk-syncs), keyed identically to the
// old connector's format so it's indistinguishable to any downstream reader.
// ---------------------------------------------------------------------------

const DAY_DEDUCTION_TYPE: Partial<Record<EmployeeDayOutcome, DeductionType>> = {
  late: "late_arrival",
  short_hours: "short_hours",
  missing_punch: "missing_punch",
};

export type EmployeeDayDecisionInfo = {
  candidateId: string;
  decisionStatus: string;
  appliedDeductionValue: number | null;
  appliedAmount: number | null;
};

/** Existing ATTENDANCE_DEVICE decisions for this employee within the range, keyed by dateIso. */
export async function getEmployeeDayDeductionDecisions(input: {
  employeeHrId: string;
  dateFromIso: string;
  dateToIso: string;
}): Promise<Map<string, EmployeeDayDecisionInfo>> {
  const hrId = normalizeAttendanceHrId(input.employeeHrId);
  const compact = compactHrKey(hrId ?? "");
  const map = new Map<string, EmployeeDayDecisionInfo>();
  if (!hrId || !compact) return map;

  const monthKeys = new Set<string>();
  for (const dateIso of listIsoDatesInRange(input.dateFromIso, input.dateToIso)) monthKeys.add(dateIso.slice(0, 7));

  for (const monthKey of monthKeys) {
    let page = 1;
    for (;;) {
      const result = await listDeductionCandidates({
        access: systemAccessContext,
        filters: { monthKey, sourceModule: "ATTENDANCE_DEVICE" },
        page,
        pageSize: 100,
      });
      for (const row of result.rows) {
        if (row.employeeHrIdCompact !== compact) continue;
        for (const dateIso of row.dates) {
          if (dateIso < input.dateFromIso || dateIso > input.dateToIso) continue;
          map.set(dateIso, {
            candidateId: row.id,
            decisionStatus: row.decision?.decisionStatus ?? "Pending",
            appliedDeductionValue: row.decision?.appliedDeductionValue ?? null,
            appliedAmount: row.decision?.appliedAmount ?? null,
          });
        }
      }
      if (result.rows.length === 0 || page * 100 >= result.total) break;
      page += 1;
    }
  }
  return map;
}

export type EmployeeDeductionSummaryRow = {
  employeeHrId: string;
  employeeName: string;
  days: number;
  amount: number;
  count: number;
};

/** Every employee with at least one CONFIRMED fingerprint deduction in the range — no employee
 * picked, company-wide. Same source table as the per-employee decisions above, just grouped.
 * Resolves real names from `employees` directly rather than trusting the candidate's own stored
 * employee_name, which is null on many older rows (pre-dating this page) and falls back to the
 * HR_ID code otherwise — this page's whole point is showing names, not codes. */
export async function getAllEmployeesFingerprintDeductionsSummary(input: {
  dateFromIso: string;
  dateToIso: string;
}): Promise<EmployeeDeductionSummaryRow[]> {
  const monthKeys = new Set<string>();
  for (const dateIso of listIsoDatesInRange(input.dateFromIso, input.dateToIso)) monthKeys.add(dateIso.slice(0, 7));

  const [names] = await Promise.all([loadEmployeeNameMap()]);

  const rows = new Map<string, EmployeeDeductionSummaryRow>();
  for (const monthKey of monthKeys) {
    let page = 1;
    for (;;) {
      const result = await listDeductionCandidates({
        access: systemAccessContext,
        filters: { monthKey, sourceModule: "ATTENDANCE_DEVICE", decisionStatus: "Approved for Payroll" },
        page,
        pageSize: 100,
      });
      for (const row of result.rows) {
        if (!row.decision || row.decision.decisionStatus !== "Approved for Payroll") continue;
        const overlaps = row.dates.some((dateIso) => dateIso >= input.dateFromIso && dateIso <= input.dateToIso);
        if (!overlaps) continue;
        const key = row.employeeHrIdCompact;
        const existing = rows.get(key) ?? {
          employeeHrId: row.employeeCode,
          employeeName: names.get(key) ?? row.employeeName ?? row.employeeCode,
          days: 0,
          amount: 0,
          count: 0,
        };
        existing.days += row.decision.appliedDeductionValue ?? 0;
        existing.amount += row.decision.appliedAmount ?? 0;
        existing.count += 1;
        rows.set(key, existing);
      }
      if (result.rows.length === 0 || page * 100 >= result.total) break;
      page += 1;
    }
  }
  return Array.from(rows.values()).sort((a, b) => b.amount - a.amount);
}

async function loadEmployeeNameMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { data, error } = await getSupabaseAdmin().from("employees").select("hr_id,full_name");
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ hr_id: string; full_name: string | null }>) {
    const key = compactHrKey(row.hr_id);
    if (key && row.full_name?.trim()) map.set(key, row.full_name.trim());
  }
  return map;
}

/**
 * Confirm or reject ONE day's deduction. Creates the ATTENDANCE_DEVICE candidate
 * on demand (idempotent — matches the deterministic candidate key if one already
 * exists from any source) using this report's own freshly-recomputed values for
 * that single day, then records the decision on it.
 */
export async function upsertAndDecideEmployeeDayDeduction(input: {
  employeeHrId: string;
  dateIso: string;
  decisionStatus: "Approved for Payroll" | "Do Not Take Action";
  /** The day fraction to decide on — the system's own value for a flagged day (late/short/missing
   * punch), or a Super-Admin-entered value for ANY other day (manual deduction the system didn't
   * flag itself, e.g. a "Complete" or "Weekly off" day the admin still wants to dock). Required
   * to approve; ignored on reject. */
  days: number;
  actorLoginId: string;
}): Promise<DeductionDecision> {
  const hrId = normalizeAttendanceHrId(input.employeeHrId);
  if (!hrId) throw validationError("Invalid employee HR id.");
  const compact = compactHrKey(hrId);

  const dayReport = await getEmployeeDayByDayReport({
    employeeHrId: hrId,
    dateFromIso: input.dateIso,
    dateToIso: input.dateIso,
  });
  const day = dayReport.days[0];
  if (!day) throw validationError("No attendance detail found for this day.");

  const days = Number(input.days);
  if (input.decisionStatus === "Approved for Payroll" && (!Number.isFinite(days) || days <= 0)) {
    throw validationError("Enter a deduction value greater than zero to approve this day.");
  }

  // A system-flagged day (late/short/missing punch) keeps its own detected value as the ceiling
  // an admin may only edit DOWN from (existing safety guard in recordCopilotDeductionDecision).
  // Any other day has no system value at all -- a Super Admin's own entry becomes both the
  // candidate's flagged value and the applied value, i.e. a from-scratch manual deduction.
  const isManualDeduction = day.deductionDays <= 0;
  const systemDays = isManualDeduction ? days : day.deductionDays;
  const deductionType: DeductionType = DAY_DEDUCTION_TYPE[day.outcome] ?? "manual_deduction";
  const monthKey = input.dateIso.slice(0, 7);

  // Reuse ANY existing non-superseded ATTENDANCE_DEVICE candidate that already covers this exact
  // employee + day, regardless of which surface created it -- the older Deductions Governance
  // Center "Sync All" connector stamps a differently-cased, differently-typed sourceRecordId for
  // the same real-world day, so an exact candidate-key match alone would miss it and create a
  // duplicate candidate for the same violation instead of deciding the one that already exists.
  let candidateId: string | null = null;
  for (let page = 1; candidateId === null; page += 1) {
    const existingForDay = await listDeductionCandidates({
      access: systemAccessContext,
      filters: { monthKey, sourceModule: "ATTENDANCE_DEVICE" },
      page,
      pageSize: 100,
    });
    const existingMatch = existingForDay.rows.find(
      (row) => row.employeeHrIdCompact === compact && row.dates.includes(input.dateIso),
    );
    if (existingMatch) candidateId = existingMatch.id;
    if (existingForDay.rows.length === 0 || page * 100 >= existingForDay.total) break;
  }

  if (candidateId) {
    // `systemDays` is always the CURRENT, freshly-computed ceiling -- the admin's own entry for
    // a manual deduction, or this day's live system-detected value otherwise (the day report is
    // never cached, so it can legitimately differ from whatever a reused candidate, especially
    // one created by the older Sync All connector, had stored). Keep the reused candidate's
    // stored ceiling in sync so a correct, higher value isn't rejected against a stale one.
    const estimatedAmount =
      dayReport.baseSalary != null
        ? (calculateDeductionAmountFromBaseSalary({
            baseSalary: dayReport.baseSalary,
            deductionDays: systemDays,
            month: Number(monthKey.slice(5, 7)),
            year: Number(monthKey.slice(0, 4)),
          }) ?? null)
        : null;
    const { error: updateError } = await getSupabaseAdmin()
      .from("deduction_candidates")
      .update({ deduction_value: Math.round(systemDays * 100) / 100, estimated_amount: estimatedAmount })
      .eq("id", candidateId);
    if (updateError) throw updateError;
  }

  if (!candidateId) {
    const draft: DeductionCandidateDraft = {
      sourceModule: "ATTENDANCE_DEVICE",
      sourceRecordId: `fingerprint:${input.dateIso}:${hrId}:${day.outcome}`,
      employeeCode: hrId,
      employeeName: dayReport.employeeName,
      monthKey,
      month: Number(monthKey.slice(5, 7)),
      year: Number(monthKey.slice(0, 4)),
      deductionType,
      deductionUnit: "days",
      deductionValue: Math.round(systemDays * 100) / 100,
      estimatedAmount:
        dayReport.baseSalary != null
          ? (calculateDeductionAmountFromBaseSalary({
              baseSalary: dayReport.baseSalary,
              deductionDays: systemDays,
              month: Number(monthKey.slice(5, 7)),
              year: Number(monthKey.slice(0, 4)),
            }) ?? null)
          : null,
      calculationStatus: "calculated",
      severity: "Medium",
      reason:
        deductionType === "manual_deduction"
          ? "Manual deduction entered via Employee Day-by-Day Report"
          : "Employee Day-by-Day Report attendance review",
      evidence: {
        firstPunchMinutes: day.firstPunchMinutes,
        lastPunchMinutes: day.lastPunchMinutes,
        lateMinutes: day.lateMinutes,
        shortMinutes: day.shortMinutes,
        outcome: day.outcome,
        reasonText: day.reason,
      },
      dates: [input.dateIso],
      hierarchySnapshot: { jobTitle: dayReport.jobTitle },
    };

    await insertDeductionCandidateDrafts({
      createdBy: input.actorLoginId,
      drafts: [draft],
      sourceLabel: "Employee Day Report",
    });

    const candidateKey = buildDeductionCandidateKey({
      sourceModule: draft.sourceModule,
      sourceRecordId: draft.sourceRecordId,
      employeeCode: draft.employeeCode,
      monthKey: draft.monthKey,
      deductionType: draft.deductionType,
      dates: draft.dates,
    });

    const { data, error } = await getSupabaseAdmin()
      .from("deduction_candidates")
      .select("id")
      .eq("source_module", "ATTENDANCE_DEVICE")
      .eq("candidate_key", candidateKey)
      .is("superseded_at", null)
      .limit(1)
      .single();
    if (error || !data) {
      throw new Error("Failed to resolve the deduction candidate for this day after creating it.");
    }
    candidateId = (data as { id: string }).id;
  }

  return recordCopilotDeductionDecision({
    candidateId,
    decisionStatus: input.decisionStatus,
    appliedDeductionValue: input.decisionStatus === "Approved for Payroll" ? days : null,
    actorLoginId: input.actorLoginId,
    source: { key: "employee-day-report", label: "Employee Day Report" },
  });
}

