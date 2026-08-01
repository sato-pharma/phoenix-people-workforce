// Unified Deductions module: CRM category connector.
//
// "CRM" = a field rep logged zero CRM/iReports360 visits that day (mandatory
// unless HR clears it — see deductions/calculations.ts's requiresApproval).
// Two populations need genuinely different logic, mirrored from
// automated-payroll/recommend.ts (must not regress its documented fixes):
//
//  - Continuing employees: reuse the same detection engine Automated Payroll's
//    p2_crm step already reads — buildFieldWorkforceRecommendationsReportForLiveMonth's
//    payrollRecommendations, sourceType "no_activity_candidate" (the ONLY place a
//    payroll_deduction recommendation is generated, per recommendations.ts's own
//    comment — it already excludes CRM-identity-unresolved employees, SFE
//    Managers, and non-eligible titles).
//  - Leavers whose last working date falls in this period: the WHOLE-MONTH
//    engine above silently mishandles them (three documented bugs — see
//    computeLeaverCrmDates's doc comment in automated-payroll/recommend.ts,
//    verified against a real production leaver B-111 whose 8 real field-visit
//    days were misread as "no activity" because her own crm_id sat in a static
//    exclusion list). This connector reproduces that corrected, truncated-span
//    scan instead of the naive whole-month path.

import { canonicalHrIdKey } from "@/lib/hr-id.ts";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { scanVisitsForRange, scanVisitsForRangeIncludingDeparted } from "@/lib/crm/reads.ts";
import { isFieldWorkforceComplianceEligibleTitle } from "@/lib/field-workforce-compliance/eligibility.ts";
import { isFieldWorkforceWeeklyOff } from "@/lib/field-workforce-compliance/weekend-policy.ts";
import { buildFieldWorkforceCompliancePreviewFromVisitsReport } from "@/lib/field-workforce-compliance/ireports360-source.ts";
import { buildFieldWorkforceRecommendationsReportForLiveMonth } from "@/lib/field-workforce-compliance/recommendations.ts";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays.ts";
import { getBaseSalaryMap } from "@/lib/payroll/copilot/feeders.ts";
import { assertBaseSalaryMapLoaded } from "./health.ts";
import { calculateDeductionAmountFromBaseSalary } from "../calculations.ts";
import { compactDeductionsHrId } from "../candidate-key.ts";
import type { DeductionsCandidateDraft, DeductionsSeverity } from "../types.ts";

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function eachDateInclusive(startIso: string, endIso: string): string[] {
  const dates: string[] = [];
  let cursor = startIso.slice(0, 10);
  const end = endIso.slice(0, 10);
  let guard = 0;
  while (cursor <= end && guard < 400) {
    dates.push(cursor);
    const next = new Date(`${cursor}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
    guard += 1;
  }
  return dates;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

/**
 * Pure: given a date -> visit-count map, returns the dates whose volume looks
 * like a data-quality gap rather than genuine company-wide inactivity.
 * Compares each date only against the median for the SAME weekday in the
 * month, so a naturally-quiet weekly-off day is never mistaken for an
 * anomaly, and only flags weekdays whose normal baseline is high enough that
 * "half of normal" is meaningfully suspicious (not just an ordinarily quiet
 * day). Verified against a real case: 2026-06-11 had 154 visits vs ~900-1,020
 * on the surrounding days — almost certainly a sync gap, not mass absence.
 */
export function detectSuspectDatesFromCounts(countByDate: Map<string, number>): Set<string> {
  const countsByWeekday = new Map<number, number[]>();
  for (const [date, count] of countByDate) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const list = countsByWeekday.get(weekday) ?? [];
    list.push(count);
    countsByWeekday.set(weekday, list);
  }

  const suspect = new Set<string>();
  for (const [date, count] of countByDate) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const baseline = median(countsByWeekday.get(weekday) ?? []);
    if (baseline >= 100 && count < baseline * 0.5) suspect.add(date);
  }
  return suspect;
}

/**
 * Company-wide CRM volume for the month, used to spot sync gaps.
 *
 * FAILS CLOSED. This used to swallow the error and return an empty suspect set
 * "so as not to block candidate generation" — which meant a CRM outage
 * disabled the exact guard designed to catch a CRM outage, and every field rep
 * was then flagged no-activity for days the data simply hadn't arrived for.
 * A missing anomaly check is not the same as "no anomalies"; the caller now
 * treats a throw as a degraded run and refuses to publish it.
 */
async function getSuspectDatesForMonth(month: number, year: number): Promise<Set<string>> {
  const monthStr = String(month).padStart(2, "0");
  const start = `${year}-${monthStr}-01`;
  const end = `${year}-${monthStr}-${String(lastDayOfMonth(year, month)).padStart(2, "0")}`;
  const rows = await scanVisitsForRange<{ visit_date: string | null }>({
    columns: "visit_date",
    dateFrom: start,
    dateTo: end,
  });

  const countByDate = new Map<string, number>();
  for (const row of rows) {
    const date = (row.visit_date ?? "").slice(0, 10);
    if (!date) continue;
    countByDate.set(date, (countByDate.get(date) ?? 0) + 1);
  }

  // Seed ELAPSED days of the month at zero before detection. A day with no
  // synced visits at all produces no row, so it never became a key — meaning a
  // total sync outage (the worst case) was invisible to the detector while a
  // merely partial gap was caught. Seeding makes a zero-visit day a
  // first-class, detectable data point.
  //
  // Only days that have actually happened: seeding not-yet-reached days of a
  // live month would drag each weekday's median down, making the detector LESS
  // sensitive — and under-detection here means MORE deductions taken against
  // possibly-missing data, which is the dangerous direction.
  const lastDay = lastDayOfMonth(year, month);
  const todayIso = new Date().toISOString().slice(0, 10);
  for (let day = 1; day <= lastDay; day += 1) {
    const date = `${year}-${monthStr}-${String(day).padStart(2, "0")}`;
    if (date > todayIso) break;
    if (!countByDate.has(date)) countByDate.set(date, 0);
  }

  return detectSuspectDatesFromCounts(countByDate);
}

/**
 * Removes suspect dates from a candidate's counted days rather than dropping
 * the whole candidate — an employee can still have genuine no-activity days
 * elsewhere in the month even if one date's company-wide data looks broken.
 * Returns null when nothing reliable is left after exclusion.
 */
export function excludeSuspectDates(
  draft: DeductionsCandidateDraft,
  suspectDates: Set<string>,
  baseSalaryByCompact: Map<string, number>,
): DeductionsCandidateDraft | null {
  const hit = draft.dates.filter((date) => suspectDates.has(date));
  if (hit.length === 0) return draft;
  const reliableDates = draft.dates.filter((date) => !suspectDates.has(date));
  if (reliableDates.length === 0) return null;

  const compactKey = compactDeductionsHrId(draft.employeeHrId);
  const baseSalary = compactKey ? (baseSalaryByCompact.get(compactKey) ?? null) : null;
  const estimatedAmount = calculateDeductionAmountFromBaseSalary({
    baseSalary,
    deductionDays: reliableDates.length,
    month: draft.month,
    year: draft.year,
  });

  return {
    ...draft,
    rawValue: reliableDates.length,
    estimatedAmount,
    calculationStatus: estimatedAmount != null ? "calculated" : "requires_review",
    dates: reliableDates,
    evidence: {
      ...draft.evidence,
      excludedSuspectDates: hit,
      suspectDateReason:
        "Company-wide CRM visit volume was anomalously low on these dates (likely a sync gap) — excluded from this employee's counted days pending data-quality review.",
    },
  };
}

type LeaverRosterEntry = { hrId: string; lastWorkingDate: string };

async function loadLeaversInPeriod(month: number, year: number): Promise<Map<string, LeaverRosterEntry>> {
  const monthStr = String(month).padStart(2, "0");
  const start = `${year}-${monthStr}-01`;
  const end = `${year}-${monthStr}-${String(lastDayOfMonth(year, month)).padStart(2, "0")}`;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_resignations")
    .select("employee_hr_id,last_working_date,exit_status")
    .gte("last_working_date", start)
    .lte("last_working_date", end)
    .in("exit_status", ["submitted", "approved", "completed"]);
  if (error) throw new Error(`Failed to load leavers for the period: ${error.message}`);

  const roster = new Map<string, LeaverRosterEntry>();
  for (const row of (data ?? []) as Array<{ employee_hr_id: string | null; last_working_date: string | null }>) {
    const hrId = row.employee_hr_id ? String(row.employee_hr_id) : "";
    const key = canonicalHrIdKey(hrId);
    if (!key || !row.last_working_date) continue;
    roster.set(key, { hrId, lastWorkingDate: String(row.last_working_date).slice(0, 10) });
  }
  return roster;
}

type LeaverVisitRow = {
  visit_date: string | null;
  visit_type: number | null;
  agent_hr_id: string | null;
  double_hr_id: string | null;
  agent_crm_id: string | null;
  double_crm_id: string | null;
};

/**
 * Reproduces automated-payroll/recommend.ts's computeLeaverCrmDates (no-activity
 * half only — AV/vacation-signal handling stays out of scope for the CRM
 * category; see the Vacation connectors instead). Bounded to
 * [max(hireDate, periodStart), lastWorkingDate], not the whole month.
 */
async function collectLeaverCrmCandidate(input: {
  hrId: string;
  crmId: string | null;
  jobTitle: string | null;
  hireDate: string | null;
  lastWorkingDate: string;
  month: number;
  year: number;
  baseSalary: number | null;
}): Promise<DeductionsCandidateDraft | null> {
  if (!isFieldWorkforceComplianceEligibleTitle(input.jobTitle)) return null;

  const monthStr = String(input.month).padStart(2, "0");
  const periodStart = `${input.year}-${monthStr}-01`;
  const periodEnd = `${input.year}-${monthStr}-${String(lastDayOfMonth(input.year, input.month)).padStart(2, "0")}`;
  const hireIso = input.hireDate ? input.hireDate.slice(0, 10) : null;
  const loopStart = hireIso && hireIso > periodStart ? hireIso : periodStart;
  const loopEnd = input.lastWorkingDate < periodEnd ? input.lastWorkingDate : periodEnd;
  if (loopStart > loopEnd) return null;

  const hrKey = canonicalHrIdKey(input.hrId) ?? "";
  const crmIdText = input.crmId != null ? String(input.crmId).trim() : "";

  const [visits, holidayResult] = await Promise.all([
    scanVisitsForRangeIncludingDeparted<LeaverVisitRow>({
      dateFrom: loopStart,
      dateTo: loopEnd,
      columns: "visit_date,visit_type,agent_hr_id,double_hr_id,agent_crm_id,double_crm_id",
    }),
    getConfirmedNationalHolidays({ month: input.month, year: input.year }),
  ]);

  const byDay = new Map<string, LeaverVisitRow[]>();
  for (const visit of visits) {
    const agentKey = canonicalHrIdKey(visit.agent_hr_id ?? "") ?? "";
    const doubleKey = canonicalHrIdKey(visit.double_hr_id ?? "") ?? "";
    const isMine =
      (agentKey && agentKey === hrKey) ||
      (doubleKey && doubleKey === hrKey) ||
      (!agentKey && crmIdText && String(visit.agent_crm_id ?? "").trim() === crmIdText) ||
      (!doubleKey && crmIdText && String(visit.double_crm_id ?? "").trim() === crmIdText);
    if (!isMine) continue;
    const dateIso = (visit.visit_date ?? "").slice(0, 10);
    if (!dateIso) continue;
    const list = byDay.get(dateIso) ?? [];
    list.push(visit);
    byDay.set(dateIso, list);
  }

  const holidayDates = new Set<string>();
  for (const holiday of holidayResult.holidays) {
    for (const date of eachDateInclusive(holiday.startDate, holiday.endDate ?? holiday.startDate)) {
      holidayDates.add(date);
    }
  }

  const noActivityDates: string[] = [];
  for (const dateIso of eachDateInclusive(loopStart, loopEnd)) {
    if (isFieldWorkforceWeeklyOff({ dateIso, title: input.jobTitle })) continue;
    if (holidayDates.has(dateIso)) continue;
    const dayVisits = byDay.get(dateIso) ?? [];
    // A day with ANY recorded visit is never "no activity" — matches
    // computeLeaverCrmDates exactly.
    if (dayVisits.length === 0) noActivityDates.push(dateIso);
  }

  if (noActivityDates.length === 0) return null;
  const monthKey = `${input.year}-${monthStr}`;
  const estimatedAmount = calculateDeductionAmountFromBaseSalary({
    baseSalary: input.baseSalary,
    deductionDays: noActivityDates.length,
    month: input.month,
    year: input.year,
  });
  return {
    category: "crm",
    sourceSystem: "crm_visits_mirror",
    sourceRecordId: `leaver:${input.hrId}:${monthKey}`,
    employeeHrId: input.hrId,
    monthKey,
    month: input.month,
    year: input.year,
    unit: "days",
    rawValue: noActivityDates.length,
    estimatedAmount,
    calculationStatus: estimatedAmount != null ? "calculated" : "requires_review",
    reason: "No CRM/field visit activity recorded (leaver settlement span)",
    evidence: { leaverLastWorkingDate: input.lastWorkingDate, hireDate: input.hireDate },
    dates: noActivityDates,
  };
}

/**
 * Employees who cannot produce a positive CRM signal for this period at all —
 * their crm_id logged ZERO visits across the whole month.
 *
 * This is the SAME data-mapping gap the no-records-activity connector already
 * guards against, and that connector's own header states the rule:
 *
 *   "an employee with zero possible positive signal ... gets flagged nearly
 *    every single workday — not a useful finding, just noise from a
 *    data-mapping gap that needs fixing once, not 20+ individual 'day without
 *    record' candidates a month"
 *
 * But that guard only tests `crm_id IS NULL`, so it catches the unmapped case
 * and misses the mapped-but-unused one, which is indistinguishable in effect.
 * Measured on July 2026 production data, the miss charged two Head Office
 * managers for essentially their entire working month:
 *
 *   A-9  Marketing Manager       20 days  30,967.74 EGP   0 CRM rows all month
 *   A-8  Group Product Manager   16 days  22,193.55 EGP   0 CRM rows all month
 *
 * Both punched in regularly (36 and 13 times) — they were at work, they simply
 * do not log visits in the CRM. Compare B-155, who has 44 CRM rows in the same
 * month: his 7 flagged days are real gaps in a system he demonstrably uses, and
 * are NOT excluded here.
 *
 * Deliberately period-scoped: "no signal this month" is the data gap. An
 * employee who normally logs visits but had a genuinely idle month still has a
 * usable signal and stays in scope.
 */
async function loadZeroCrmSignalHrIdKeys(input: {
  dateFrom: string;
  dateTo: string;
}): Promise<Set<string>> {
  const zeroSignal = new Set<string>();
  try {
    const supabase = getSupabaseAdmin();
    const [{ data: employeeRows, error }, visits] = await Promise.all([
      supabase.from("employees").select("hr_id,job_title,crm_id"),
      scanVisitsForRangeIncludingDeparted<LeaverVisitRow>({
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        columns: "visit_date,visit_type,agent_hr_id,double_hr_id,agent_crm_id,double_crm_id",
      }),
    ]);
    // Defensive, matching loadCrmIdentityUnresolvedHrIdKeys: if this check
    // cannot run, exclude nobody rather than silently suppressing real findings.
    if (error) return zeroSignal;

    const activeHrKeys = new Set<string>();
    const activeCrmIds = new Set<string>();
    for (const visit of visits) {
      const agentKey = canonicalHrIdKey(visit.agent_hr_id ?? "");
      const doubleKey = canonicalHrIdKey(visit.double_hr_id ?? "");
      if (agentKey) activeHrKeys.add(agentKey);
      if (doubleKey) activeHrKeys.add(doubleKey);
      const agentCrm = String(visit.agent_crm_id ?? "").trim();
      const doubleCrm = String(visit.double_crm_id ?? "").trim();
      if (agentCrm) activeCrmIds.add(agentCrm);
      if (doubleCrm) activeCrmIds.add(doubleCrm);
    }

    for (const row of (employeeRows ?? []) as Array<{
      hr_id: string;
      job_title: string | null;
      crm_id: string | null;
    }>) {
      if (!isFieldWorkforceComplianceEligibleTitle(row.job_title)) continue;
      const key = canonicalHrIdKey(row.hr_id);
      if (!key) continue;
      const crmIdText = row.crm_id != null ? String(row.crm_id).trim() : "";
      const hasSignal = activeHrKeys.has(key) || (crmIdText !== "" && activeCrmIds.has(crmIdText));
      if (!hasSignal) zeroSignal.add(key);
    }
  } catch {
    return new Set();
  }
  return zeroSignal;
}

/**
 * Continuing-employee candidates via the shared FWC recommendations engine.
 * Excludes anyone in leaverHrIdKeys — those are handled by
 * collectLeaverCrmCandidate over their own truncated settlement span instead.
 */
async function collectContinuingEmployeeCrmCandidates(input: {
  month: number;
  year: number;
  leaverHrIdKeys: Set<string>;
  baseSalaryByCompact: Map<string, number>;
}): Promise<DeductionsCandidateDraft[]> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const preview = await buildFieldWorkforceCompliancePreviewFromVisitsReport({
    month: input.month,
    year: input.year,
    todayIso,
  });
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const report = await buildFieldWorkforceRecommendationsReportForLiveMonth({ monthKey, preview });

  const monthStr = String(input.month).padStart(2, "0");
  const zeroCrmSignalKeys = await loadZeroCrmSignalHrIdKeys({
    dateFrom: `${input.year}-${monthStr}-01`,
    dateTo: `${input.year}-${monthStr}-${String(lastDayOfMonth(input.year, input.month)).padStart(2, "0")}`,
  });

  const drafts: DeductionsCandidateDraft[] = [];
  for (const recommendation of report.payrollRecommendations) {
    if (recommendation.sourceType !== "no_activity_candidate") continue;
    const key = canonicalHrIdKey(recommendation.employeeCode) ?? "";
    if (key && input.leaverHrIdKeys.has(key)) continue;
    // Zero CRM signal for the whole month is a data-mapping gap, not a
    // field-activity failure — see loadZeroCrmSignalHrIdKeys.
    if (key && zeroCrmSignalKeys.has(key)) continue;

    // baseSalaryByCompact is keyed by compactDeductionsHrId (hyphens stripped),
    // NOT canonicalHrIdKey (hyphens kept, used for `key` above) — a distinct
    // lookup is required or every base salary lookup silently misses.
    const compactKey = compactDeductionsHrId(recommendation.employeeCode);
    const baseSalary = compactKey ? (input.baseSalaryByCompact.get(compactKey) ?? null) : null;
    const estimatedAmount = calculateDeductionAmountFromBaseSalary({
      baseSalary,
      deductionDays: recommendation.daysCount,
      month: input.month,
      year: input.year,
    });

    drafts.push({
      category: "crm",
      sourceSystem: "crm_visits_mirror",
      sourceRecordId: `${recommendation.importId}:${recommendation.recommendationKey}`,
      employeeHrId: recommendation.employeeCode,
      employeeName: recommendation.employeeName,
      monthKey: recommendation.monthKey,
      month: input.month,
      year: input.year,
      unit: "days",
      rawValue: recommendation.daysCount,
      estimatedAmount,
      calculationStatus: estimatedAmount != null ? "calculated" : "requires_review",
      severity: recommendation.severity as DeductionsSeverity,
      reason: "Field Workforce Compliance no-activity candidate",
      evidence: {
        recommendationKey: recommendation.recommendationKey,
        recommendationReason: recommendation.recommendationReason,
        existingCoverageStatus: recommendation.existingCoverageStatus,
      },
      dates: recommendation.dates,
      hierarchySnapshot: {
        areaName: recommendation.areaName,
        lineName: recommendation.lineName,
        managerName: recommendation.managerName,
        roleName: recommendation.roleName,
        teamName: recommendation.teamName,
      },
    });
  }
  return drafts;
}

export async function collectCrmCandidates(input: {
  month: number;
  year: number;
}): Promise<DeductionsCandidateDraft[]> {
  const [leaverRoster, baseSalaryByCompact, suspectDates] = await Promise.all([
    loadLeaversInPeriod(input.month, input.year),
    getBaseSalaryMap(),
    // Throws on a CRM outage rather than silently returning "no anomalies" —
    // see getSuspectDatesForMonth's own note.
    getSuspectDatesForMonth(input.month, input.year),
  ]);
  // Fail closed: without salaries every amount resolves to null, and the old
  // publish path turned that into a 0.00 EGP deduction that looked successful.
  assertBaseSalaryMapLoaded("CRM connector", baseSalaryByCompact);
  const leaverHrIdKeys = new Set(leaverRoster.keys());

  const leaverDrafts: DeductionsCandidateDraft[] = [];
  if (leaverRoster.size > 0) {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id,crm_id,job_title,hire_date")
      .in("hr_id", Array.from(leaverRoster.values(), (entry) => entry.hrId));
    if (error) throw new Error(`Failed to load leaver employee records: ${error.message}`);

    for (const employeeRow of (data ?? []) as Array<{ hr_id: string; crm_id: string | null; job_title: string | null; hire_date: string | null }>) {
      const key = canonicalHrIdKey(employeeRow.hr_id) ?? "";
      const roster = key ? leaverRoster.get(key) : undefined;
      if (!roster) continue;
      const compactKey = compactDeductionsHrId(employeeRow.hr_id);
      const draft = await collectLeaverCrmCandidate({
        hrId: roster.hrId,
        crmId: employeeRow.crm_id,
        jobTitle: employeeRow.job_title,
        hireDate: employeeRow.hire_date,
        lastWorkingDate: roster.lastWorkingDate,
        month: input.month,
        year: input.year,
        baseSalary: compactKey ? (baseSalaryByCompact.get(compactKey) ?? null) : null,
      });
      if (draft) leaverDrafts.push(draft);
    }
  }

  const continuingDrafts = await collectContinuingEmployeeCrmCandidates({
    month: input.month,
    year: input.year,
    leaverHrIdKeys,
    baseSalaryByCompact,
  });

  if (suspectDates.size === 0) {
    return [...leaverDrafts, ...continuingDrafts];
  }
  const cleaned: DeductionsCandidateDraft[] = [];
  for (const draft of [...leaverDrafts, ...continuingDrafts]) {
    const result = excludeSuspectDates(draft, suspectDates, baseSalaryByCompact);
    if (result) cleaned.push(result);
  }
  return cleaned;
}
