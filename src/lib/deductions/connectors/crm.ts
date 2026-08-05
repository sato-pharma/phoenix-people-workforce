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
import { isFieldWorkforceComplianceEligibleTitle, logsOwnCrmVisitsTitle } from "@/lib/field-workforce-compliance/eligibility.ts";
import {
  isFieldWorkforceWeeklyOff,
  sumFieldWorkforceDeductionDayWeights,
} from "@/lib/field-workforce-compliance/weekend-policy.ts";
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
 * Compares each date against the median for the SAME weekday in the month, so a
 * naturally-quiet weekly-off day is never mistaken for an anomaly, and only
 * flags weekdays whose normal baseline is high enough that "half of normal" is
 * meaningfully suspicious (not just an ordinarily quiet day). Verified against a
 * real case: 2026-06-11 had 154 visits vs ~900-1,020 on the surrounding days —
 * almost certainly a sync gap, not mass absence.
 *
 * 🔴 A same-weekday median DEFEATS ITSELF when the anomaly IS the weekday.
 * The median is computed from that weekday's own days, so a weekday that is
 * systematically depressed encodes the depression in its own baseline and can
 * never flag itself. Measured on July 2026 production:
 *
 *   Sun-Wed, Sat   730-924 visits      (a healthy working day)
 *   Thursday       4, 14, 143, 363, 450  -> weekday median 143
 *
 * Thursday's baseline came out at 143 against ~860 for every other working day,
 * so 2026-07-09 sat EXACTLY ON its own median and was unflaggable — while an
 * identical 143 on a Wednesday would have been caught instantly. Three depressed
 * Thursdays produced 78 of the month's 247 flagged employee-days (32%),
 * 62,435.47 EGP, against 43 people who were following a company-wide pattern.
 *
 * Fix: when a weekday's own median is depressed BUT that weekday demonstrably
 * reaches working-day volume at least once in the month, its median is evidence
 * of the anomaly rather than a baseline — fall back to the month-wide median.
 *
 * The peak is what separates the two cases, and it has to be, or this would
 * break the weekly-off protection above:
 *
 *   Thursday  median 143, PEAK 450  -> a working day having a bad month
 *   Friday    median   7, PEAK   8  -> genuinely a day off, never a candidate
 *
 * Friday keeps its own median and stays unflagged, exactly as before; Thursday
 * falls back to the month and 2026-07-09 / 2026-07-16 finally register.
 */
export function detectSuspectDatesFromCounts(countByDate: Map<string, number>): Set<string> {
  const countsByWeekday = new Map<number, number[]>();
  for (const [date, count] of countByDate) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const list = countsByWeekday.get(weekday) ?? [];
    list.push(count);
    countsByWeekday.set(weekday, list);
  }

  // Robust to weekly-off days: they are a minority of the month (5 Fridays in
  // 31 days), so the month-wide median still lands on a normal working day.
  const monthBaseline = median([...countByDate.values()]);

  // TWO DIFFERENT RATIOS, DELIBERATELY. They answer different questions and moving
  // them together breaks one of the two cases below.
  //
  // workingDayFloor asks "is this weekday a working day at all?" — used on the
  // weekday's PEAK to tell a depressed working day (Thursday, peak 450) from a
  // genuine day off (Friday, peak 8). Raising it to 0.6 would put Thursday's peak
  // under the floor, cancel its month fallback, and un-flag 2026-07-09 / 07-16.
  const workingDayFloor = monthBaseline * 0.5;
  // SUSPECT_RATIO asks "is THIS day's volume a data gap?" Widened from 0.5 to 0.6 so
  // 2026-07-30 registers: 450 visits against an 802 baseline is 56%, with 73 of ~80
  // reps still logging — near-normal participation at half the volume, which is a
  // company-wide half day, not 13 reps independently skipping work.
  //
  // Calibrated against four months of production rather than fitted to one day.
  // Newly suspect at 0.6 vs 0.5: April 0, May 0, June 0, July exactly one (07-30).
  // There is a real gap in this company's distribution between a normal day and an
  // anomalous one, so the wider ratio costs nothing elsewhere. Over-suspicion only
  // ever REMOVES deduction days, which is the safe direction the seeding note below
  // already argues for.
  const SUSPECT_RATIO = 0.6;

  const suspect = new Set<string>();
  for (const [date, count] of countByDate) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekdayCounts = countsByWeekday.get(weekday) ?? [];
    const weekdayBaseline = median(weekdayCounts);
    const weekdayPeak = weekdayCounts.length > 0 ? Math.max(...weekdayCounts) : 0;
    // Depressed median + a peak that still reaches working-day volume = a
    // working weekday whose own median has been dragged under by the anomaly.
    const weekdayIsSelfDefeating = weekdayBaseline < workingDayFloor && weekdayPeak >= workingDayFloor;
    const baseline = weekdayIsSelfDefeating ? monthBaseline : weekdayBaseline;
    if (baseline >= 100 && count < baseline * SUSPECT_RATIO) suspect.add(date);
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
export function collectLeaverCrmCandidate(input: {
  hrId: string;
  crmId: string | null;
  jobTitle: string | null;
  hireDate: string | null;
  lastWorkingDate: string;
  month: number;
  year: number;
  baseSalary: number | null;
  /**
   * The month's visits, scanned ONCE by the caller and shared by every leaver.
   *
   * This used to be a per-leaver `scanVisitsForRangeIncludingDeparted` inside this
   * function — and that scan is NOT employee-filtered, so each leaver pulled the
   * whole company's visits for their span and then threw all but their own away in
   * the `isMine` filter below. July 2026's 10 leavers therefore cost 10 sequential
   * company-wide paginated scans, on top of the byte-identical one
   * `loadZeroCrmSignalHrIdKeys` already ran. See collectCrmCandidates.
   *
   * A WIDER window than this leaver's settlement span is safe by construction: the
   * only consumer of `byDay` is the `eachDateInclusive(loopStart, loopEnd)` loop
   * below, so a day outside the span is never looked up.
   */
  monthVisits: readonly LeaverVisitRow[];
  /**
   * Confirmed national-holiday dates for the month. The caller has already refused a
   * degraded calendar — see assertHolidayCalendarUsable, which is where the
   * fail-closed guard that used to live here now sits, so it is evaluated once
   * instead of once per leaver.
   */
  holidayDates: ReadonlySet<string>;
}): DeductionsCandidateDraft | null {
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

  const byDay = new Map<string, LeaverVisitRow[]>();
  for (const visit of input.monthVisits) {
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

  const noActivityDates: string[] = [];
  for (const dateIso of eachDateInclusive(loopStart, loopEnd)) {
    if (isFieldWorkforceWeeklyOff({ dateIso, title: input.jobTitle })) continue;
    if (input.holidayDates.has(dateIso)) continue;
    const dayVisits = byDay.get(dateIso) ?? [];
    // A day with ANY recorded visit is never "no activity" — matches
    // computeLeaverCrmDates exactly.
    if (dayVisits.length === 0) noActivityDates.push(dateIso);
  }

  if (noActivityDates.length === 0) return null;
  const monthKey = `${input.year}-${monthStr}`;
  // Thursday is a half day (owner rule 2026-08-02), so the money comes off a WEIGHTED day count
  // while `rawValue`/`dates` keep reporting the real number of flagged days — the evidence and
  // the charge stay separately auditable.
  const deductionDays = sumFieldWorkforceDeductionDayWeights(noActivityDates, input.jobTitle);
  const estimatedAmount = calculateDeductionAmountFromBaseSalary({
    baseSalary: input.baseSalary,
    deductionDays,
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
  /**
   * The month's visits, from collectCrmCandidates' single shared scan. This used to
   * run its own `scanVisitsForRangeIncludingDeparted` over exactly the same range
   * with exactly the same projection as every leaver's — see collectCrmCandidates.
   */
  visits: readonly LeaverVisitRow[];
}): Promise<Set<string>> {
  const zeroSignal = new Set<string>();
  try {
    const supabase = getSupabaseAdmin();
    const { data: employeeRows, error } = await supabase.from("employees").select("hr_id,job_title,crm_id");
    const visits = input.visits;
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
  /** The month's visits, from collectCrmCandidates' single shared scan. */
  monthVisits: readonly LeaverVisitRow[];
}): Promise<DeductionsCandidateDraft[]> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const preview = await buildFieldWorkforceCompliancePreviewFromVisitsReport({
    month: input.month,
    year: input.year,
    todayIso,
  });
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const report = await buildFieldWorkforceRecommendationsReportForLiveMonth({ monthKey, preview });

  const zeroCrmSignalKeys = await loadZeroCrmSignalHrIdKeys({ visits: input.monthVisits });

  // Job titles from the roster, NOT recommendation.roleName. The day weight depends on the title
  // (Saturday is a working day for Medical Reps / District Sales Managers and a weekly off for
  // everyone else), and roleName comes from a hierarchy snapshot that is null for a real slice of
  // live rows — 5 of July 2026's 24 CRM candidates. A null title reads as "Saturday off" and would
  // silently weight those Saturdays to zero, under-deducting.
  const titleByHrIdKey = new Map<string, string | null>();
  {
    const { data } = await getSupabaseAdmin().from("employees").select("hr_id,job_title");
    for (const row of (data ?? []) as Array<{ hr_id: string; job_title: string | null }>) {
      const key = canonicalHrIdKey(row.hr_id);
      if (key) titleByHrIdKey.set(key, row.job_title);
    }
  }

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
    // Thursday is a half day (owner rule 2026-08-02), so the charge comes off a WEIGHTED count
    // while rawValue/dates keep reporting the real flagged days. Falls back to the unweighted
    // count only when a recommendation carries no per-day dates — there is nothing to weight
    // then, and inventing weights for unknown dates would be a guess about someone's pay.
    const jobTitle = titleByHrIdKey.get(canonicalHrIdKey(recommendation.employeeCode) ?? "") ?? null;
    const deductionDays = recommendation.dates.length > 0
      ? sumFieldWorkforceDeductionDayWeights(recommendation.dates, jobTitle)
      : recommendation.daysCount;
    const estimatedAmount = calculateDeductionAmountFromBaseSalary({
      baseSalary,
      deductionDays,
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

/** The projection every `IncludingDeparted` read in this connector shares. */
const LEAVER_VISIT_COLUMNS = "visit_date,visit_type,agent_hr_id,double_hr_id,agent_crm_id,double_crm_id";

/**
 * The month's confirmed national-holiday dates, refusing a degraded calendar.
 *
 * FAIL CLOSED — the same stance getSuspectDatesForMonth and assertBaseSalaryMapLoaded
 * already take in this connector.
 *
 * The Google Egypt calendar is the only source of MOVING Islamic and Coptic holidays (Eid
 * al-Fitr, Eid al-Adha, Islamic New Year, the Prophet's Birthday, Coptic Christmas). When it
 * cannot be read, getConfirmedNationalHolidays degrades to company + FIXED-date holidays only
 * and says so via calendarReachable:false — every moving holiday silently becomes an ordinary
 * working day, and a rep who correctly took Eid off is charged a no-activity deduction for it.
 * The degraded result is also cached for 10 minutes, so one transient outage poisons every run
 * in that window. The continuing-employee path inherits the equivalent guard from Field
 * Workforce Compliance (isHolidaySourceDegraded); this leaver path had none, and a leaver's
 * final settlement is the worst place to over-deduct because it is the hardest to correct.
 *
 * Lifted out of collectLeaverCrmCandidate so it is fetched and checked ONCE per run rather
 * than once per leaver. Still called only when the month actually has leavers to settle, so a
 * month with none keeps acquiring no holiday-calendar dependency at all — exactly as before.
 */
async function loadLeaverHolidayDates(month: number, year: number): Promise<Set<string>> {
  const holidayResult = await getConfirmedNationalHolidays({ month, year });
  if (holidayResult.calendarReachable === false || holidayResult.connected === false) {
    throw new Error(
      `CRM connector: the national-holiday calendar is degraded for ${year}-${String(month).padStart(2, "0")}` +
        ` (${holidayResult.message ?? "no detail reported"}).` +
        " Refusing to compute leaver CRM no-activity deductions: moving Islamic/Coptic holidays" +
        " would be missing and charged as working days.",
    );
  }
  const holidayDates = new Set<string>();
  for (const holiday of holidayResult.holidays) {
    for (const date of eachDateInclusive(holiday.startDate, holiday.endDate ?? holiday.startDate)) {
      holidayDates.add(date);
    }
  }
  return holidayDates;
}

export async function collectCrmCandidates(input: {
  month: number;
  year: number;
}): Promise<DeductionsCandidateDraft[]> {
  const monthStr = String(input.month).padStart(2, "0");
  const periodStart = `${input.year}-${monthStr}-01`;
  const periodEnd = `${input.year}-${monthStr}-${String(lastDayOfMonth(input.year, input.month)).padStart(2, "0")}`;

  const [leaverRoster, baseSalaryByCompact, suspectDates, monthVisits] = await Promise.all([
    loadLeaversInPeriod(input.month, input.year),
    getBaseSalaryMap(),
    // Throws on a CRM outage rather than silently returning "no anomalies" —
    // see getSuspectDatesForMonth's own note.
    getSuspectDatesForMonth(input.month, input.year),
    // ONE company-wide scan of the whole month, shared by every consumer below.
    //
    // This connector used to run this exact query, with this exact projection, once per
    // leaver PLUS once inside loadZeroCrmSignalHrIdKeys — and none of those reads was
    // employee-filtered, so each pulled the entire company's visits and discarded all but
    // one person's. July 2026: 18,544 visit rows, keyset-paginated 1,000 at a time = 19
    // sequential round trips per scan, 11 scans (10 leavers + the zero-signal check) =
    // ~209 round trips, every one of them crossing the Atlantic (Railway runs in `sfo`,
    // Supabase in `eu-central-1`). Postgres answers the month in 61 ms; the cost was
    // entirely latency x round trips. That is what ran past the gateway and reported the
    // connector as failed with no warning attached. Now: 19 round trips, once.
    scanVisitsForRangeIncludingDeparted<LeaverVisitRow>({
      dateFrom: periodStart,
      dateTo: periodEnd,
      columns: LEAVER_VISIT_COLUMNS,
    }),
  ]);
  // Fail closed: without salaries every amount resolves to null, and the old
  // publish path turned that into a 0.00 EGP deduction that looked successful.
  assertBaseSalaryMapLoaded("CRM connector", baseSalaryByCompact);
  const leaverHrIdKeys = new Set(leaverRoster.keys());

  const leaverDrafts: DeductionsCandidateDraft[] = [];
  if (leaverRoster.size > 0) {
    // Once per run, and only when there are leavers — see loadLeaverHolidayDates.
    const holidayDates = await loadLeaverHolidayDates(input.month, input.year);
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
      // No I/O left in here: pure computation over the shared scan, so the loop that
      // used to serialise 10 company-wide scans now costs nothing per leaver.
      const draft = collectLeaverCrmCandidate({
        hrId: roster.hrId,
        crmId: employeeRow.crm_id,
        jobTitle: employeeRow.job_title,
        hireDate: employeeRow.hire_date,
        lastWorkingDate: roster.lastWorkingDate,
        month: input.month,
        year: input.year,
        baseSalary: compactKey ? (baseSalaryByCompact.get(compactKey) ?? null) : null,
        monthVisits,
        holidayDates,
      });
      if (draft) leaverDrafts.push(draft);
    }
  }

  const continuingDrafts = await collectContinuingEmployeeCrmCandidates({
    month: input.month,
    year: input.year,
    leaverHrIdKeys,
    baseSalaryByCompact,
    monthVisits,
  });

  const collected: DeductionsCandidateDraft[] = [];
  if (suspectDates.size === 0) {
    collected.push(...leaverDrafts, ...continuingDrafts);
  } else {
    for (const draft of [...leaverDrafts, ...continuingDrafts]) {
      const result = excludeSuspectDates(draft, suspectDates, baseSalaryByCompact);
      if (result) collected.push(result);
    }
  }

  // NO SALARY BASIS ⇒ NO SALARY-BASED DEDUCTION.
  //
  // A day-rate deduction is Base Salary ÷ days in month, so with no base salary
  // recorded there is nothing to take a fraction OF. "Not deductible" is the honest
  // answer; "deductible, amount unknown" is not, and publishMonth refuses any month
  // containing a null-amount candidate — so one unsalaried person blocked payday for
  // everyone. July 2026 carried exactly this for a leaver sitting at base_salary 0.
  //
  // Applied at the single exit point rather than at the three emit sites, so a future
  // fourth branch cannot reintroduce it. Safe because the SYSTEMIC case is already
  // guarded by assertBaseSalaryMapLoaded above: reaching here means the map loaded
  // and this employee genuinely is not in it.
  const withAmount = collected.filter((draft) => draft.estimatedAmount != null);

  // ONLY THOSE WHO LOG THEIR OWN VISITS CAN BE JUDGED ON NOT LOGGING THEM.
  //
  // A Medical Rep owns a contact list and enters visits, so an empty day is that rep's
  // own signal. A manager has no contact list and does not hand-enter visits — the rep
  // submits and TAGS them — so a manager's empty day measures the rep's data entry, and
  // the manager has no mechanism to correct it. See logsOwnCrmVisitsTitle.
  //
  // July 2026: 16 managers/PMs held 131,741.94 EGP, 77% of this category, and 35 of those
  // charged days had a fingerprint punch (53,258.06 EGP) — charged for missing field
  // visits while demonstrably clocked in at the office.
  const titleByKey = new Map<string, string | null>();
  {
    const { data } = await getSupabaseAdmin().from("employees").select("hr_id,job_title");
    for (const row of (data ?? []) as Array<{ hr_id: string; job_title: string | null }>) {
      const key = canonicalHrIdKey(row.hr_id);
      if (key) titleByKey.set(key, row.job_title);
    }
  }
  // Fail closed on an unreadable roster: with no titles we cannot tell a rep from a
  // manager, and guessing in the permissive direction is what charged managers in the
  // first place. An empty roster means no candidates, not "everyone qualifies".
  return withAmount.filter((draft) => {
    const key = canonicalHrIdKey(draft.employeeHrId);
    return key ? logsOwnCrmVisitsTitle(titleByKey.get(key) ?? null) : false;
  });
}
