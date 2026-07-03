// DB-backed weekly-digest generator: fetches live data, composes it through
// the pure core (digest-cycle → digest-reconcile → flexible-hours →
// digest-generator), and persists the result.
//
// Scope is entirely data-driven, not hardcoded: an employee participates in the
// weekly digest only once their RESOLVED ACTIVE POLICY has `required_minutes`
// set (i.e. an owner has migrated them onto a flexible-hours policy via the
// admin Policies screen, per migration 20260703180000). The policy's
// `judgment_mode` decides the tier (every_working_day vs office_days_only).
// This means the actual roster is whatever the owner configures in the admin
// UI — no employee list lives in this code.
//
// KNOWN GAP (documented, not silently dropped): half-day approved leave
// (AM/PM split at attendance_policy_groups.half_day_split_minutes) is not yet
// wired — only full-day approved leave (v2_vacation_requests) cancels a day.
// Adjusting `requiredMinutes` for a half-day leave needs the half-day/duration
// field on the leave request, which has not been mapped yet.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId, resolveActiveAttendancePolicy } from "@/lib/attendance/metrics";
import { loadAttendanceFlexPolicyGroups, type AttendanceFlexPolicyGroupDbRow } from "@/lib/attendance/policy-groups";
import { getAttendanceRoster } from "@/lib/attendance/roster";
import {
  buildAttendanceCalendarContext,
  classifyAttendanceDay,
  getApprovedLeaveDayMap,
  listIsoDatesInRange,
} from "@/lib/attendance/working-days";
import { getApprovedExcuseDayMap } from "@/lib/attendance/approved-excuse-days";
import { getAttendanceExceptionMap } from "@/lib/attendance/exceptions";
import { getCompanyWideOutageDates } from "@/lib/attendance/ingestion-health";
import { getPlanOfficeDayMap } from "@/lib/attendance/plan-office-days";
import { loadEmployeeDayPunchMinutes, type EmployeeDayPunches } from "@/lib/attendance/punch-minutes";
import {
  buildEmployeeWeekDigest,
  type DigestDayInput,
  type DigestFlag,
  type DigestLineDraft,
} from "@/lib/attendance/digest-generator";
import type { AttendanceJudgmentMode } from "@/lib/attendance/digest-reconcile";
import type { DeductionBracket, FlexibleHoursConfig } from "@/lib/attendance/flexible-hours";
import type { SettlementWeek } from "@/lib/attendance/digest-cycle";

type PolicyRuleRow = {
  policy_id: number;
  event_type: string | null;
  from_minutes: number | null;
  to_minutes: number | null;
  deduction_days: number | string | null;
  is_active: boolean | null;
};

export type EmployeeWeekDigestResult = {
  employeeHrId: string;
  tier: AttendanceJudgmentMode;
  lines: DigestLineDraft[];
  flags: DigestFlag[];
  totalDeductionDays: number;
  totalDeductionValue: number;
};

function timeToMinutes(value: string | null | undefined): number | null {
  const [hourText, minuteText] = String(value ?? "").slice(0, 5).split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return hour * 60 + minute;
}

function bracketsForEventType(rules: PolicyRuleRow[], policyId: number, eventType: string): DeductionBracket[] {
  return rules
    .filter((rule) => rule.policy_id === policyId && rule.event_type === eventType && rule.is_active !== false)
    .map((rule) => ({
      fromMinutes: rule.from_minutes ?? 1,
      toMinutes: rule.to_minutes,
      deductionDays: Number(rule.deduction_days) || 0,
    }))
    .sort((left, right) => left.fromMinutes - right.fromMinutes);
}

type ScopedEmployee = {
  hrId: string;
  jobTitle: string;
  tier: AttendanceJudgmentMode;
  policy: AttendanceFlexPolicyGroupDbRow;
};

export type ComputeSettlementWeekDigestsResult = {
  results: EmployeeWeekDigestResult[];
  /** Employees whose data couldn't be trusted this run — held, not guessed at. Never silently dropped; the caller must log these. */
  skipped: DigestGenerationSkip[];
};

/**
 * Compute (but do not persist) one settlement week's digest for every employee
 * whose resolved active policy has flexible-hours fields configured. Read-only.
 *
 * Fail-closed on bad data: a per-employee failure (missing/broken data) never
 * blocks the rest of the week's generation, and never produces a digest built
 * on data that couldn't be verified — that employee is held (skipped) and
 * reported back, not guessed at.
 */
export async function computeSettlementWeekDigests(week: SettlementWeek): Promise<ComputeSettlementWeekDigestsResult> {
  const supabase = getSupabaseAdmin();

  const [roster, flexPolicies] = await Promise.all([
    getAttendanceRoster({ dateFromIso: week.startIso, dateToIso: week.endIso }),
    loadAttendanceFlexPolicyGroups({ activeOnly: true }),
  ]);

  const scoped: ScopedEmployee[] = [];
  for (const employee of roster) {
    const policy = resolveActiveAttendancePolicy(
      { hr_id: employee.hrId, job_title: employee.jobTitle },
      flexPolicies,
      week.startIso,
      week.endIso,
    );
    // Not yet migrated onto a flexible-hours policy — not in scope for the digest.
    if (!policy || policy.required_minutes == null) continue;
    scoped.push({ hrId: employee.hrId, jobTitle: employee.jobTitle, tier: policy.judgment_mode, policy });
  }
  if (scoped.length === 0) return { results: [], skipped: [] };

  const hrIds = scoped.map((employee) => employee.hrId);

  // Fetched unfiltered and matched client-side by normalized HR_ID — never
  // filter the employees table by a pre-normalized (uppercase) hr_id via .in(),
  // since the DB column's actual casing is not guaranteed to match (a
  // recurring bug class in this codebase). Mirrors the pattern already used in
  // fingerprint-report.ts and roster.ts.
  const [employeeResult, ruleResult, context, leaveMap, excuseMap, exceptionMap, planMap, punchMap, outageDates] = await Promise.all([
    supabase.from("employees").select("hr_id,base_salary"),
    supabase
      .from("attendance_policy_rules")
      .select("policy_id,event_type,from_minutes,to_minutes,deduction_days,is_active")
      .eq("is_active", true),
    buildAttendanceCalendarContext({ dateFromIso: week.startIso, dateToIso: week.endIso }),
    getApprovedLeaveDayMap({ dateFromIso: week.startIso, dateToIso: week.endIso, employeeHrIds: hrIds }),
    getApprovedExcuseDayMap({ dateFromIso: week.startIso, dateToIso: week.endIso, employeeHrIds: hrIds }),
    getAttendanceExceptionMap(hrIds, week.startIso, week.endIso),
    getPlanOfficeDayMap({ dateFromIso: week.startIso, dateToIso: week.endIso, employeeHrIds: hrIds }),
    loadEmployeeDayPunchMinutes({ dateFromIso: week.startIso, dateToIso: week.endIso, employeeHrIds: hrIds }),
    // Device-outage fail-safe: a day with zero punches company-wide never
    // becomes a false missing-punch/field-punch-anomaly for anyone.
    getCompanyWideOutageDates(week.startIso, week.endIso),
  ]);

  if (employeeResult.error) throw employeeResult.error;
  if (ruleResult.error) throw ruleResult.error;

  const salaryByHrId = new Map<string, number | null>();
  for (const row of (employeeResult.data ?? []) as Array<{ hr_id: string; base_salary: number | null }>) {
    const hrId = normalizeAttendanceHrId(row.hr_id);
    if (hrId) salaryByHrId.set(hrId, row.base_salary);
  }

  const rules = (ruleResult.data ?? []) as PolicyRuleRow[];
  const dates = listIsoDatesInRange(week.startIso, week.endIso);
  const results: EmployeeWeekDigestResult[] = [];

  const skipped: DigestGenerationSkip[] = [];

  for (const employee of scoped) {
    // Fail-closed on bad data: one employee's bad/incomplete data must never
    // block the whole week's generation for everyone else, and must never
    // produce a digest built on data we couldn't trust — it's simply skipped
    // (held) and logged for follow-up, never silently guessed at.
    try {
      const policy = employee.policy;
      const scheduledStartMinutes = timeToMinutes(policy.scheduled_start) ?? 9 * 60;
      const config: FlexibleHoursConfig = {
        scheduledStartMinutes,
        flexCeilingMinutes: scheduledStartMinutes + (policy.flex_minutes ?? 0),
        requiredMinutes: policy.required_minutes!,
      };
      const lateBrackets = bracketsForEventType(rules, policy.id, "late");
      const shortBrackets = bracketsForEventType(rules, policy.id, "short_hours");

      const leaveDates = leaveMap.get(employee.hrId) ?? new Set<string>();
      const excuseDates = excuseMap.get(employee.hrId) ?? new Set<string>();
      const officeDates = planMap.get(employee.hrId) ?? new Map<string, boolean>();
      const punches = punchMap.get(employee.hrId) ?? new Map<string, EmployeeDayPunches>();

      const days: DigestDayInput[] = [];
      for (const dateIso of dates) {
        const classification = classifyAttendanceDay({
          context,
          dateIso,
          jobTitle: employee.jobTitle,
          workingWeekdays: policy.working_weekdays,
        });
        // Future days are not part of a digest yet — nothing to reconcile.
        if (classification.isFuture) continue;

        const hasApprovedException = exceptionMap.get(`${employee.hrId}|${dateIso}`)?.status === "approved";
        const punchInfo = punches.get(dateIso);

        days.push({
          dateIso,
          reconcile: {
            tier: employee.tier,
            isWorkingDay: !classification.isWeeklyOff,
            isHoliday: classification.isHoliday,
            hasApprovedLeave: leaveDates.has(dateIso) || hasApprovedException,
            hasApprovedExcuse: excuseDates.has(dateIso),
            planSaysOffice: officeDates.get(dateIso) ?? null,
            hasPunch: (punchInfo?.visiblePunchCount ?? 0) > 0,
            deviceOutage: outageDates.has(dateIso),
          },
          firstPunchMinutes: punchInfo?.firstPunchMinutes ?? null,
          lastPunchMinutes: punchInfo?.lastPunchMinutes ?? null,
          visiblePunchCount: punchInfo?.visiblePunchCount ?? 0,
          config,
          lateBrackets,
          shortBrackets,
        });
      }

      const digest = buildEmployeeWeekDigest({ baseSalary: salaryByHrId.get(employee.hrId) ?? null, days });
      results.push({ employeeHrId: employee.hrId, tier: employee.tier, ...digest });
    } catch (error) {
      skipped.push({ employeeHrId: employee.hrId, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { results, skipped };
}

export type DigestGenerationSkip = { employeeHrId: string; reason: string };

/**
 * Persist a computed batch of weekly digests: creates or updates the digest
 * header (totals) and replaces its lines. Does not send anything and does not
 * branch on attendance_digest_settings.dry_run — dry-run governs whether a
 * later settlement step actually applies a deduction, not whether a digest is
 * computed and shown.
 *
 * Safety: a digest that has already moved past 'draft' (sent / settled /
 * auto_confirmed) is NEVER touched — re-running the generator must not reset
 * an in-flight or completed digest back to draft and wipe out the employee's
 * confirm/dispute actions on its lines. Those employees are reported back in
 * `skipped` rather than silently overwritten.
 */
export async function persistSettlementWeekDigests(input: {
  cycleKey: string;
  week: SettlementWeek;
  digests: EmployeeWeekDigestResult[];
}): Promise<{ digestIds: number[]; skipped: string[] }> {
  const supabase = getSupabaseAdmin();
  const digestIds: number[] = [];
  const skipped: string[] = [];
  if (input.digests.length === 0) return { digestIds, skipped };

  const employeeHrIds = input.digests.map((digest) => digest.employeeHrId);
  const { data: existingRows, error: existingError } = await supabase
    .from("attendance_weekly_digests")
    .select("id,employee_hr_id,status")
    .eq("cycle_key", input.cycleKey)
    .eq("week_index", input.week.index)
    .in("employee_hr_id", employeeHrIds);
  if (existingError) throw existingError;

  const existingByEmployee = new Map(
    ((existingRows ?? []) as Array<{ id: number; employee_hr_id: string; status: string }>).map((row) => [
      row.employee_hr_id,
      row,
    ]),
  );

  for (const digest of input.digests) {
    const existing = existingByEmployee.get(digest.employeeHrId);
    if (existing && existing.status !== "draft") {
      skipped.push(digest.employeeHrId);
      continue;
    }

    const { data: digestRow, error: digestError } = await supabase
      .from("attendance_weekly_digests")
      .upsert(
        {
          employee_hr_id: digest.employeeHrId,
          cycle_key: input.cycleKey,
          week_index: input.week.index,
          week_start: input.week.startIso,
          week_end: input.week.endIso,
          status: "draft",
          total_deduction_days: digest.totalDeductionDays,
          total_deduction_value: digest.totalDeductionValue,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "employee_hr_id,cycle_key,week_index" },
      )
      .select("id")
      .single();

    if (digestError) throw digestError;
    const digestId = (digestRow as { id: number }).id;
    digestIds.push(digestId);

    // Draft-only lines are always safe to replace wholesale — a re-run before
    // sending simply recomputes from scratch.
    const { error: deleteError } = await supabase
      .from("attendance_digest_lines")
      .delete()
      .eq("digest_id", digestId);
    if (deleteError) throw deleteError;

    if (digest.lines.length > 0) {
      const { error: insertError } = await supabase.from("attendance_digest_lines").insert(
        digest.lines.map((line) => ({
          digest_id: digestId,
          work_date: line.dateIso,
          status: line.status,
          late_minutes: line.lateMinutes,
          short_minutes: line.shortMinutes,
          worked_minutes: line.workedMinutes,
          deduction_days: line.deductionDays,
          deduction_value: line.deductionValue,
          reason: line.reason,
          action: "pending",
        })),
      );
      if (insertError) throw insertError;
    }
  }

  return { digestIds, skipped };
}
