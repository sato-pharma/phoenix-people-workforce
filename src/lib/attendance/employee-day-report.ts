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
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
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
import { getPlanOfficeDayDetailMap } from "@/lib/attendance/plan-office-days";
import {
  officeHalfConfig,
  planOfficeCoveredPart,
  planOfficeDayNote,
  type PlanOfficeDay,
} from "@/lib/attendance/plan-office-resolution";
import { loadEmployeeDayPunchMinutes } from "@/lib/attendance/punch-minutes";
import { describeReconcileSkip, reconcileDay, type AttendanceJudgmentMode } from "@/lib/attendance/digest-reconcile";
import {
  bracketsForEventType,
  evaluateFlexibleHoursDay,
  type AttendancePolicyRuleRow,
  type FlexibleHoursConfig,
} from "@/lib/attendance/flexible-hours";
import { validationError } from "@/lib/http/api-errors";
// The day rate is Base ÷ the month's ACTUAL calendar days — the owner's standing rule, and
// now the only implementation of it that exists.
//
// THERE USED TO BE TWO FUNCTIONS WITH THIS NAME. They differed only in the divisor, and the
// ÷30 one took no month at all — so calling the wrong one was invisible: it type-checked
// perfectly and simply produced a different number. This file imported the ÷30 version, so
// every fingerprint deduction ignored the owner's standing "day rate = Base ÷ actual
// calendar days, EVERYWHERE" rule while every other category honoured it.
//
// Measured on July 2026 production (31 days): Ali Mohamed Ali 90,000 ÷ 30 × 2.13 = 6,390.00
// where ÷31 gives 6,183.87; Ahmed El Maraghy 37,500 ÷ 30 × 3.26 = 4,075.00. Across the
// category that over-charged ~3.3% (~789 EGP of 24,460.21) — and would UNDER-charge 6.7%
// in February, so it is wrong in both directions, not merely conservative.
//
// THE ÷30 TWIN IS GONE, so there is no wrong one left to import. This comment used to say
// deductions-governance/calculations.ts kept its ÷30 deliberately because it fed the legacy
// governance module and Automated Payroll: that module was deleted on 2026-08-30, and
// Automated Payroll's own flat rate was retired by the owner's ruling of 2026-09-12 (audit
// finding 37). One function remains, and its month and year are required arguments.
import { calculateDeductionAmountFromBaseSalary } from "@/lib/deductions/calculations.ts";
import { getAttendanceRoster } from "@/lib/attendance/roster";
import { cairoTodayIso } from "@/lib/attendance/working-days";
// Unified Deductions module (Track C cutover). This report used to write the
// legacy deductions-governance tables, which ONLY the now-retired Payroll
// Copilot ever read — so a confirmation here never reached live Automated
// Payroll, which reads the unified deductions_candidates/deductions_decisions.
// This repoint (owner-approved: "Reconnect") makes a day-report confirmation
// charge in live payroll. Dedup is safe by construction: the monthly fingerprint
// connector (connectors/fingerprint.ts) and this file build the SAME
// candidate_key for a given employee+day — both use sourceSystem
// "fingerprint_report" and sourceRecordId `${normalizeAttendanceHrId(hrId)}:${dateIso}`
// — and this file also runs a by-day reuse scan first, so the collector and an
// on-demand confirmation converge on ONE candidate instead of double-charging.
import { assertFingerprintDayApprovable, insertCandidateDrafts, listCandidatesForMonth, recordDecision } from "@/lib/deductions/service.ts";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import { dayChargeTarget, ledgerClaimMonthKeys, OFFICE_CYCLE_FIRST_MONTH_KEY } from "@/lib/deductions/cycle.ts";
import { loadOnePartEmployeeCompacts } from "@/lib/deductions/cycle-population.ts";
import type { DeductionsCandidateDraft, DeductionsDecision } from "@/lib/deductions/types.ts";
import type { AccessContext } from "@/lib/auth/permissions";

export type FlexEligibleEmployeeOption = { hrId: string; employeeName: string; jobTitle: string };

/** Every employee carrying at least one live (non-superseded) fingerprint deduction
 * candidate, regardless of their CURRENT attendance-policy resolution. Confirmed real case
 * 2026-07-24: an employee can have an always-active per-employee policy override
 * (required_minutes: null) that predates a deduction candidate the now-retired weekly digest
 * created for them anyway — once that override is in place, listFlexEligibleEmployees's normal
 * roster/policy scan can never resolve them again, so without this union that candidate becomes
 * permanently unreachable from this report (no way to open, confirm, or reject it) even though
 * it may already be "Approved for Payroll". Independent of the roster/date-range scan above; a
 * small table, so this is a cheap full scan rather than trying to thread a date range through it.
 * Matches on employee_hr_id_compact — the SAME alias-aware derivation the unified table stores —
 * so an aliased HR_ID (e.g. AAA→AA) is not silently dropped. */
async function listEmployeesWithOutstandingAttendanceCandidates(): Promise<FlexEligibleEmployeeOption[]> {
  const supabase = getSupabaseAdmin();
  const { data: candidateRows, error: candidateError } = await supabase
    .from("deductions_candidates")
    .select("employee_hr_id_compact")
    .eq("category", "fingerprint")
    .is("superseded_at", null);
  if (candidateError) throw candidateError;
  const wanted = new Set(
    ((candidateRows ?? []) as Array<{ employee_hr_id_compact: string | null }>)
      .map((row) => row.employee_hr_id_compact)
      .filter((value): value is string => Boolean(value)),
  );
  if (wanted.size === 0) return [];

  const { data: employeeRows, error: employeeError } = await supabase.from("employees").select("hr_id,full_name,nickname,job_title");
  if (employeeError) throw employeeError;
  const result: FlexEligibleEmployeeOption[] = [];
  for (const row of (employeeRows ?? []) as Array<{ hr_id: string; full_name: string | null; nickname: string | null; job_title: string | null }>) {
    const compact = compactDeductionsHrId(row.hr_id);
    const hrId = normalizeAttendanceHrId(row.hr_id);
    if (!compact || !hrId || !wanted.has(compact)) continue;
    const fullName = row.full_name?.trim();
    result.push({
      employeeName: fullName ? resolveEmployeeDisplayName(fullName, row.nickname, row.hr_id) : hrId,
      hrId,
      jobTitle: row.job_title?.trim() ?? "",
    });
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
  /** Null when the reason would only restate the outcome. */
  reason: string | null;
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
  /** The name the screen prints: the nickname the company uses, else the full name. */
  employeeName: string;
  /** The stored full name, and the only name written onto a deduction candidate: that row feeds
   * payroll, which keeps the legal name. Never printed by this report. */
  employeeFullName: string;
  jobTitle: string;
  /** For live-recalculating a day's EGP value client-side as its deduction days are edited —
   * the grid calls the server's own calculateDeductionAmountFromBaseSalary with the charged
   * day's month, so an edited display value can never drift from what Approve saves. It said
   * "base/30 x days" until the 2026-09-12 ruling, and in a 31-day month the figure a reviewer
   * approved was 3.3% above the one that was stored. */
  baseSalary: number | null;
  /** Null when this employee isn't on the flexible-hours model (required_minutes unset) — the
   * same "excepted" population the digest engine skips entirely. */
  tier: AttendanceJudgmentMode | null;
  dateFromIso: string;
  dateToIso: string;
  days: EmployeeDayReportRow[];
  /** False when Google's holiday calendar could not be read for a month in the range: the moving
   * Islamic and Coptic holidays are missing, so an Eid day reads here as an ordinary working day.
   * Approving a deduction is refused while it is false (owner, 2026-09-16). */
  holidayCalendarReachable: boolean;
};

type EmployeeRow = { hr_id: string; full_name: string | null; nickname: string | null; job_title: string | null; base_salary: number | null };
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
      supabase.from("employees").select("hr_id,full_name,nickname,job_title,base_salary"),
      loadAttendanceFlexPolicyGroups({ activeOnly: true }),
      supabase
        .from("attendance_policy_rules")
        .select("policy_id,event_type,from_minutes,to_minutes,deduction_days,is_active")
        .eq("is_active", true),
      buildAttendanceCalendarContext({ dateFromIso: input.dateFromIso, dateToIso: input.dateToIso }),
      getApprovedLeaveDayMap({ dateFromIso: input.dateFromIso, dateToIso: input.dateToIso, employeeHrIds: [hrId] }),
      getApprovedExcuseDayMap({ dateFromIso: input.dateFromIso, dateToIso: input.dateToIso, employeeHrIds: [hrId] }),
      getAttendanceExceptionMap([hrId], input.dateFromIso, input.dateToIso),
      getPlanOfficeDayDetailMap({ dateFromIso: input.dateFromIso, dateToIso: input.dateToIso, employeeHrIds: [hrId] }),
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
  const employeeFullName = employee.full_name?.trim() || hrId;
  const employeeName = employee.full_name?.trim()
    ? resolveEmployeeDisplayName(employeeFullName, employee.nickname, employee.hr_id)
    : hrId;

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
  const officeDates = planMap.get(hrId) ?? new Map<string, PlanOfficeDay>();
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
      planSaysOffice: officeDates.get(dateIso)?.isOffice ?? null,
      tier: dayPolicy.policy.judgment_mode,
    });
    // Only an office-days-only seat is judged by the plan, so only there does the plan need
    // explaining: a half-day Office plan, or an approved monthly plan the weekly plan overrode.
    const planDay = dayPolicy.policy.judgment_mode === "office_days_only" ? officeDates.get(dateIso) : undefined;
    const planNote = planOfficeDayNote(planDay);
    const withPlanNote = (reason: string | null) => (planNote ? [reason, planNote].filter(Boolean).join(" ") : reason);

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
      const reason = crmDetail ? [decision.reason, crmDetail].filter(Boolean).join(" — ") : decision.reason;
      days.push(dayRow(
        dateIso,
        outcome,
        outcome === "no_plan_field_day" ? withPlanNote(reason) : reason,
        firstPunchMinutes,
        lastPunchMinutes,
        visiblePunchCount,
      ));
      continue;
    }

    if (decision.action === "flag") {
      days.push(dayRow(
        dateIso,
        decision.flagType === "office_no_show" ? "office_no_show_flag" : "field_punch_anomaly_flag",
        withPlanNote(decision.reason),
        firstPunchMinutes,
        lastPunchMinutes,
        visiblePunchCount,
      ));
      continue;
    }

    // "judge" — run the exact same math the digest engine settles from. A half-day Office plan is
    // half an office day (owner, 2026-10-19): the office half is judged with the same half-day math
    // an approved half-day vacation uses — half the required presence, and an afternoon office half
    // judged from where the afternoon begins.
    const result = evaluateFlexibleHoursDay({
      config: officeHalfConfig(config, planOfficeCoveredPart(planDay)),
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
      reason: withPlanNote(result.reason),
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
    employeeFullName,
    employeeHrId: hrId,
    employeeName,
    holidayCalendarReachable: context.holidayCalendarReachable,
    jobTitle,
    tier: reportTier,
  };
}

function dayRow(
  dateIso: string,
  outcome: EmployeeDayOutcome,
  reason: string | null,
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
// Reads and writes the UNIFIED deductions_candidates/deductions_decisions rows
// (category "fingerprint") that live Automated Payroll actually reads — a
// candidate created here is created on demand (this report never bulk-syncs)
// but keyed identically to the monthly fingerprint connector, so the collector
// and an on-demand confirmation converge on ONE candidate per employee+day
// rather than double-charging. See the import block for the dedup argument.
// ---------------------------------------------------------------------------

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
  const compact = compactDeductionsHrId(hrId ?? "");
  const map = new Map<string, EmployeeDayDecisionInfo>();
  if (!hrId || !compact) return map;

  // Each day's month AND the next — a one-part employee's day from the 22nd on sits on the Head
  // Office cycle row of the following payroll month (deductions/cycle.ts).
  const monthKeys = new Set<string>();
  for (const dateIso of listIsoDatesInRange(input.dateFromIso, input.dateToIso)) {
    for (const monthKey of ledgerClaimMonthKeys(dateIso.slice(0, 7))) monthKeys.add(monthKey);
  }

  for (const monthKey of monthKeys) {
    const candidates = await listCandidatesForMonth({ monthKey, category: "fingerprint", employeeHrIdCompact: compact });
    for (const candidate of candidates) {
      for (const dateIso of candidate.dates) {
        if (dateIso < input.dateFromIso || dateIso > input.dateToIso) continue;
        map.set(dateIso, {
          candidateId: candidate.id,
          decisionStatus: candidate.decision?.decisionStatus ?? "Pending",
          appliedDeductionValue: candidate.decision?.appliedValue ?? null,
          appliedAmount: candidate.decision?.appliedAmount ?? null,
        });
      }
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
  for (const dateIso of listIsoDatesInRange(input.dateFromIso, input.dateToIso)) {
    for (const monthKey of ledgerClaimMonthKeys(dateIso.slice(0, 7))) monthKeys.add(monthKey);
  }

  const [names] = await Promise.all([loadEmployeeNameMap()]);

  const rows = new Map<string, EmployeeDeductionSummaryRow>();
  for (const monthKey of monthKeys) {
    const candidates = await listCandidatesForMonth({ monthKey, category: "fingerprint" });
    for (const candidate of candidates) {
      if (!candidate.decision || candidate.decision.decisionStatus !== "Approved for Payroll") continue;
      const overlaps = candidate.dates.some((dateIso) => dateIso >= input.dateFromIso && dateIso <= input.dateToIso);
      if (!overlaps) continue;
      const key = candidate.employeeHrIdCompact;
      const existing = rows.get(key) ?? {
        employeeHrId: candidate.employeeHrId,
        employeeName: names.get(key) ?? candidate.employeeName ?? candidate.employeeHrId,
        days: 0,
        amount: 0,
        count: 0,
      };
      existing.days += candidate.decision.appliedValue ?? 0;
      existing.amount += candidate.decision.appliedAmount ?? 0;
      existing.count += 1;
      rows.set(key, existing);
    }
  }
  return Array.from(rows.values()).sort((a, b) => b.amount - a.amount);
}

async function loadEmployeeNameMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { data, error } = await getSupabaseAdmin().from("employees").select("hr_id,full_name,nickname");
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ hr_id: string; full_name: string | null; nickname: string | null }>) {
    const key = compactDeductionsHrId(row.hr_id);
    const fullName = row.full_name?.trim();
    if (key && fullName) map.set(key, resolveEmployeeDisplayName(fullName, row.nickname, row.hr_id));
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
  /** Super Admin actor — gated by recordDecision's own role check; its hrId/loginId also
   * become the candidate's created_by and the decision's decided_by/audit actor. */
  actor: Pick<AccessContext, "role" | "hrId" | "loginId">;
}): Promise<DeductionsDecision & { payrollNotices: string[] }> {
  const hrId = normalizeAttendanceHrId(input.employeeHrId);
  if (!hrId) throw validationError("Invalid employee HR id.");
  // Alias-aware, byte-for-byte the derivation the unified table stores in
  // employee_hr_id_compact — matching on anything else silently drops an aliased HR_ID.
  const compact = compactDeductionsHrId(hrId);
  if (!compact) throw validationError("Invalid employee HR id.");

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
  // an admin may only edit DOWN from (resolveDecisionCharge rejects appliedValue > raw_value).
  // Any other day has no system value at all -- a Super Admin's own entry becomes both the
  // candidate's raw value and the applied value, i.e. a from-scratch manual deduction.
  const isManualDeduction = day.deductionDays <= 0;
  const systemDays = isManualDeduction ? days : day.deductionDays;
  const rawValue = Math.round(systemDays * 100) / 100;
  // The payroll month this day is charged to — the SAME month the collection run keys it to
  // (deductions/cycle.ts). From October 2026 an employee paid in one part is on the Head Office cycle,
  // so his day from the 22nd on belongs to the NEXT payroll month; keyed to its calendar month it would
  // sit beside the office row for the same day and be charged twice. An unreadable directory refuses.
  const calendarMonthKey = input.dateIso.slice(0, 7);
  const isOnePart =
    calendarMonthKey >= OFFICE_CYCLE_FIRST_MONTH_KEY ? (await loadOnePartEmployeeCompacts()).has(compact) : false;
  const target = dayChargeTarget(input.dateIso, isOnePart);
  const { monthKey, month, year } = target;
  // Priced on the day's own calendar month, as the connector that finds the same day prices it.
  const estimatedAmount =
    dayReport.baseSalary != null
      ? (calculateDeductionAmountFromBaseSalary({
          baseSalary: dayReport.baseSalary,
          deductionDays: systemDays,
          month: Number(calendarMonthKey.slice(5, 7)),
          year: Number(calendarMonthKey.slice(0, 4)),
        }) ?? null)
      : null;

  // A Google Calendar outage hides the moving Islamic and Coptic holidays, so this day could be an
  // Eid that reads here as an ordinary working day — and approving writes a deduction marked
  // "Approved for Payroll". Refuse the approval while the calendar cannot be read. Rejecting a day
  // ("Do Not Take Action") stays open: that is the direction that costs nobody money (owner,
  // 2026-09-16).
  if (input.decisionStatus === "Approved for Payroll" && !dayReport.holidayCalendarReachable) {
    throw validationError(
      "The public holiday calendar could not be read, so this day cannot be told apart from a public holiday. Nothing was charged — try again shortly.",
    );
  }

  // The weekly attendance review's own checks, BEFORE anything is written. recordDecision runs them
  // too, but only after the candidate below has been created or its stored ceiling raised — and a
  // refusal then leaves that write behind, for a day the review says is not payroll's to charge.
  if (input.decisionStatus === "Approved for Payroll") {
    await assertFingerprintDayApprovable({ employeeHrId: hrId, dates: [input.dateIso] });
  }

  // 1) Reuse ANY existing non-superseded fingerprint candidate that already covers this exact
  //    employee + day, whichever surface created it (the monthly connector, or an earlier
  //    confirmation here). listCandidatesForMonth returns the whole month already paged; matching
  //    on the alias-aware compact key + the day is the primary dedup — it catches the common
  //    "collector ran first" case even if source_record_id cased differently.
  //    The day's calendar month AND the next one: an office-cycle row of the next payroll month carries
  //    the 22nd on, and a row an earlier path keyed to the calendar month may already hold the day —
  //    either way the day is decided on the row that has it, never added a second time.
  const resolveExisting = async () => {
    for (const claimMonthKey of ledgerClaimMonthKeys(calendarMonthKey)) {
      const monthCandidates = await listCandidatesForMonth({
        monthKey: claimMonthKey,
        category: "fingerprint",
        employeeHrIdCompact: compact,
      });
      const found = monthCandidates.find((candidate) => candidate.dates.includes(input.dateIso));
      if (found) return found;
    }
    return null;
  };

  let candidate = await resolveExisting();

  if (candidate) {
    // `systemDays` is always the CURRENT, freshly-computed ceiling. The day report is never
    // cached, so it can legitimately differ from whatever the reused candidate stored (especially
    // one collected weeks ago). Keep the stored ceiling in sync so a correct, higher value isn't
    // rejected against a stale one — recordDecision re-reads the candidate, so this update is seen.
    const { error: updateError } = await getSupabaseAdmin()
      .from("deductions_candidates")
      .update({ raw_value: rawValue, estimated_amount: estimatedAmount })
      .eq("id", candidate.id);
    if (updateError) throw updateError;
  } else {
    const draft: DeductionsCandidateDraft = {
      category: "fingerprint",
      sourceSystem: "fingerprint_report",
      // Byte-identical to the monthly connector's format (connectors/fingerprint.ts), so a later
      // company-wide collection dedups against THIS row on candidate_key instead of creating a
      // second candidate for the same violation. (hrId is already the alias-aware canonical form
      // getFingerprintAttendanceReport emits, so the two keys always agree.)
      sourceRecordId: `${hrId}:${input.dateIso}`,
      employeeHrId: hrId,
      employeeName: dayReport.employeeFullName,
      monthKey,
      month,
      year,
      unit: "days",
      rawValue,
      estimatedAmount,
      calculationStatus: "calculated",
      severity: "Medium",
      reason: isManualDeduction
        ? "Manual deduction entered via Employee Day-by-Day Report"
        : "Employee Day-by-Day Report attendance review",
      evidence: {
        firstPunchMinutes: day.firstPunchMinutes,
        lastPunchMinutes: day.lastPunchMinutes,
        lateMinutes: day.lateMinutes,
        shortMinutes: day.shortMinutes,
        outcome: day.outcome,
        reasonText: day.reason,
        ...(target.cycleEvidence ? { deductionCycle: target.cycleEvidence } : {}),
      },
      dates: [input.dateIso],
      hierarchySnapshot: { jobTitle: dayReport.jobTitle },
    };

    await insertCandidateDrafts({
      createdBy: input.actor.hrId ?? input.actor.loginId ?? "system",
      drafts: [draft],
      sourceLabel: "Employee Day Report",
    });

    // Re-list rather than trust a key we rebuilt by hand: insertCandidateDrafts owns the key
    // derivation, and this also collapses onto whatever row a concurrent collector just wrote.
    candidate = await resolveExisting();
    if (!candidate) {
      throw new Error("Failed to resolve the deduction candidate for this day after creating it.");
    }
  }

  // 2) Record the decision on the resolved candidate. recordDecision re-derives the charge from
  //    the DB candidate (never from the request) and enforces the raw_value ceiling; a reject
  //    records the decision with no charge.
  return recordDecision({
    actor: input.actor,
    candidateId: candidate.id,
    decisionStatus: input.decisionStatus,
    decisionReason: isManualDeduction
      ? "Manual deduction — Employee Day-by-Day Report"
      : "Employee Day-by-Day Report attendance review",
    appliedValue: input.decisionStatus === "Approved for Payroll" ? days : null,
  });
}

