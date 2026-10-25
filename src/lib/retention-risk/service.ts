/**
 * Retention risk — the reading half. Every rule about what counts lives in ./detector.ts; this
 * file only gathers the calendars and hands them over.
 *
 * COST. The CRM half is a scan of the visits mirror (~55,000 rows over 90 days, measured
 * 2026-09-06), which is far too heavy to repeat on every landing-page render. Two things keep it
 * honest: the scan is narrowed to the reps the silence rule can apply to, and the RESULT — a
 * handful of small signal objects — is what goes in the cache, never the visit rows. Caching the
 * rows instead would blow past the 2 MB `unstable_cache` ceiling that kills the dev server, and a
 * Map would come back as `{}` from that cache anyway.
 */

import { unstable_cache } from "next/cache";

import { serveWithoutCaching, unwrapServedWithoutCaching } from "@/lib/cache/serve-uncached";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getEmployeeDirectoryRows, isActiveDirectoryEmployee } from "@/lib/employees/employee-directory";
import { isRetentionRiskSubjectTitle } from "@/lib/retention-risk/eligibility";
import { getNationalHolidayDateSet } from "@/lib/vacation/national-holidays";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { queryVisits } from "@/lib/crm/reads";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { loadPhoenixWorkEvidenceDays } from "@/lib/crm/phoenix-work-evidence";
import { mergePhoenixWorkEvidence } from "@/lib/retention-risk/phoenix-evidence";
import {
  RETENTION_RISK_THRESHOLD_WORKING_DAYS,
  addDays,
  buildRetentionRiskSignals,
} from "@/lib/retention-risk/detector";
import type { RetentionRiskSignal, RetentionRiskSubject } from "@/lib/retention-risk/types";


/**
 * How far back the board looks. Long enough to cover a full payroll cycle and the one before it,
 * short enough that the mirror scan stays bounded.
 */
const SCAN_WINDOW_DAYS = 45;

/**
 * Extra days read BEFORE the window, used only to place each rep's first CRM entry.
 *
 * A rep whose account produced its first row inside the window is ramping up, not vanishing, and
 * must not be measured for the days before it. Without this lead-in every new joiner is reported
 * in their first fortnight, which is the fastest way to teach HR to ignore the board.
 */
const FIRST_ACTIVITY_LEAD_IN_DAYS = 21;

/**
 * How far FORWARD approved leave is read. Leave is a record HR already wrote, so a block dated
 * into next week is readable today — and a five-day leave straddling payroll is exactly what the
 * pre-payroll warning exists to surface.
 */
const LEAVE_LOOKAHEAD_DAYS = 30;

const CACHE_REVALIDATE_SECONDS = 2 * 60 * 60;

/** Africa/Cairo calendar day — the company's business day, never UTC. */
export function cairoDateIso(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(at);
}

/**
 * The most recent day the CRM can be read for.
 *
 * NEVER today. Reps enter visits through and after the working day and the mirror syncs three
 * times a day, so a same-day read is empty for the entire field force. Measuring today would
 * report every rep in the company as silent every single morning.
 */
export function retentionRiskMeasurableThrough(now: Date = new Date()): string {
  return addDays(cairoDateIso(now), -1);
}

export type RetentionRiskWindow = {
  /** Inclusive last date of the scan — the leave look-ahead end. */
  end: string;
  /** Last date CRM silence can be judged to. */
  measurableThrough: string;
  /** Inclusive first date of the scan. */
  start: string;
};

export function resolveRetentionRiskWindow(now: Date = new Date()): RetentionRiskWindow {
  const measurableThrough = retentionRiskMeasurableThrough(now);
  return {
    end: addDays(cairoDateIso(now), LEAVE_LOOKAHEAD_DAYS),
    measurableThrough,
    start: addDays(measurableThrough, -(SCAN_WINDOW_DAYS - 1)),
  };
}

type VisitDayRow = { agent_hr_id: string | null; visit_date: string | null };

type LeaveRow = {
  employee_hr_id: string | null;
  end_date: string | null;
  start_date: string | null;
  status: string | null;
};

/**
 * Leave rows that count as recorded absence.
 *
 * Anything not rejected or cancelled: an approved block obviously counts, and so does one still
 * waiting for HR — the person is away either way, and a pending five-day request sitting over
 * payroll is a stronger warning than an approved one, not a weaker one. Production statuses
 * measured 2026-09-06: approved (514), pending_hr (11), rejected (9), pending_manager (1).
 */
function isRecordedLeaveStatus(status: string | null): boolean {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return !normalized.includes("reject") && !normalized.includes("cancel");
}

async function loadLeaveDates(startDate: string, endDate: string): Promise<Map<string, Set<string>>> {
  const { data, error } = await getSupabaseAdmin()
    .from("v2_vacation_requests")
    .select("employee_hr_id,start_date,end_date,status")
    .lte("start_date", endDate)
    .gte("end_date", startDate);
  if (error) throw new Error(`Failed to load leave requests for retention risk: ${error.message}`);

  const byHrId = new Map<string, Set<string>>();
  for (const row of (data ?? []) as LeaveRow[]) {
    if (!isRecordedLeaveStatus(row.status)) continue;
    const key = canonicalHrIdKey(row.employee_hr_id);
    if (!key || !row.start_date || !row.end_date) continue;
    const from = row.start_date < startDate ? startDate : row.start_date;
    const to = row.end_date > endDate ? endDate : row.end_date;
    if (from > to) continue;
    let bucket = byHrId.get(key);
    if (!bucket) {
      bucket = new Set<string>();
      byHrId.set(key, bucket);
    }
    for (let date = from; date <= to; date = addDays(date, 1)) bucket.add(date);
  }
  return byHrId;
}

/**
 * Every date on which the CRM holds ANY entry for each rep, plus the earliest one seen.
 *
 * "Any entry" is deliberate and is the whole difference between this and the compliance report: a
 * conference, a training day, a meeting, a CRM-recorded vacation — all of them prove the person
 * was still touching the system. Only a day with NOTHING at all counts as silence, which is the
 * narrowest and least accusatory reading of the owner's rule.
 */
/**
 * How many hr ids go into one `.in()`.
 *
 * A PostgREST `.in()` carrying several hundred values returns ZERO ROWS AND NO ERROR in this
 * system. That failure would be catastrophic here in a way it is not elsewhere: zero activity rows
 * means every rep reads as silent, so the board would name the entire field force and the sweep
 * would notify HR about all of them — a silent read fault presenting as sixty-nine resignations.
 *
 * `queryVisits` sprays each id's casing variants (`expandHrIdFilterValues`), roughly doubling the
 * count, and its own doc comment warns that its hr-id lists are meant to be per-employee or
 * per-cohort rather than company-wide. Sixty-nine reps is company-wide by that standard, so this
 * chunks — and `loadCrmActivity` reports the row count so a zero can never pass as an answer.
 */
const HR_ID_FILTER_CHUNK = 40;

/**
 * How many of those chunks are scanned at once. They are independent reads of the same window, so
 * one after another only stacked round trips; they are folded in chunk order all the same.
 */
const CHUNK_CONCURRENCY = 4;

async function loadCrmActivity(
  hrIds: readonly string[],
  scanStart: string,
  scanEnd: string,
): Promise<{ activity: Map<string, Set<string>>; firstSeen: Map<string, string>; rowCount: number }> {
  const activity = new Map<string, Set<string>>();
  const firstSeen = new Map<string, string>();
  if (hrIds.length === 0) return { activity, firstSeen, rowCount: 0 };

  const chunks: string[][] = [];
  for (let index = 0; index < hrIds.length; index += HR_ID_FILTER_CHUNK) {
    chunks.push(hrIds.slice(index, index + HR_ID_FILTER_CHUNK));
  }
  // The Phoenix CRM evidence is read alongside the chunks rather than after them: it depends on
  // none of them. Any failure still rejects the whole load, as it did when these ran in sequence.
  const [chunkRows, phoenixEvidence] = await Promise.all([
    mapWithConcurrency(chunks, CHUNK_CONCURRENCY, (agentHrIds) =>
      queryVisits<VisitDayRow>({
        agentHrIds,
        columns: "agent_hr_id,visit_date",
        dateFrom: scanStart,
        dateTo: scanEnd,
        // A rep who has already left is not a flight risk, and their rows would be excluded anyway;
        // leaving the default in place keeps departed-agent data invisible here as everywhere else.
        requireAgentHrId: true,
      }),
    ),
    loadPhoenixWorkEvidenceDays({ end: scanEnd, start: scanStart }),
  ]);

  let rowCount = 0;
  for (const rows of chunkRows) {
    rowCount += rows.length;

    for (const row of rows) {
      const key = canonicalHrIdKey(row.agent_hr_id);
      if (!key || !row.visit_date) continue;
      let bucket = activity.get(key);
      if (!bucket) {
        bucket = new Set<string>();
        activity.set(key, bucket);
      }
      bucket.add(row.visit_date);
      const earliest = firstSeen.get(key);
      if (!earliest || row.visit_date < earliest) firstSeen.set(key, row.visit_date);
    }
  }
  // Phoenix CRM work the counting view hides (a team not yet started). A failed read throws, which
  // the caller turns into "CRM unavailable" rather than naming reps who were provably working.
  mergePhoenixWorkEvidence(activity, firstSeen, phoenixEvidence);
  return { activity, firstSeen, rowCount };
}

/**
 * Turn the directory into detector subjects.
 *
 * Every subject reaching here is already a Medical Rep — the caller filters on
 * `logsOwnCrmVisitsTitle` for BOTH rules (owner, 2026-09-07). `watchCrmSilence` is therefore true
 * for all of them today; it stays a per-subject flag rather than a constant so the detector keeps
 * saying out loud which rule it is applying to whom.
 */
function buildSubjects(
  employees: readonly Awaited<ReturnType<typeof getEmployeeDirectoryRows>>[number][],
  firstSeen: ReadonlyMap<string, string>,
): RetentionRiskSubject[] {
  const subjects: RetentionRiskSubject[] = [];
  for (const employee of employees) {
    const key = canonicalHrIdKey(employee.hrId);
    if (!key) continue;
    subjects.push({
      areaName: employee.areaName,
      // Passed RAW — the detector takes the latest of this, the hire date and the window start, so
      // an account that was already producing before the window needs no special case here.
      //
      // NULL means the scan saw nothing at all, and that is why the detector skips such a subject
      // for silence rather than reporting a 45-day disappearance. Measured on production
      // 2026-09-06: of 69 active medical reps, exactly 4 had no CRM row in the 66-day scan — and
      // those same 4 have never had one in the mirror's whole history. "Silent for the entire
      // window" and "no CRM account yet" are the same four people, so treating null as a signal
      // would report only unmapped accounts, which src/lib/crm/unmapped-alert.ts already covers.
      firstCrmActivityDate: firstSeen.get(key) ?? null,
      hireDate: employee.hireDate,
      hrId: employee.hrId,
      displayName: employee.displayName || employee.fullName,
      jobTitle: employee.jobTitle,
      lastWorkingDate: employee.lastWorkingDate,
      lineName: employee.lineName,
      managerHrId: employee.managerHrId,
      managerName: employee.managerName,
      positionTitle: employee.positionTitle,
      watchCrmSilence: isRetentionRiskSubjectTitle(employee.jobTitle, employee.positionTitle),
    });
  }
  return subjects;
}

export type RetentionRiskView = {
  /** When this was computed, ISO instant. */
  computedAt: string;
  /** True when the CRM half could not be read — the board must say so rather than show zero. */
  crmUnavailable: boolean;
  measurableThrough: string;
  signals: RetentionRiskSignal[];
  thresholdWorkingDays: number;
  windowEnd: string;
  windowStart: string;
};

async function computeRetentionRisk(nowIso: string): Promise<RetentionRiskView> {
  const now = new Date(nowIso);
  const window = resolveRetentionRiskWindow(now);
  const scanStart = addDays(window.start, -FIRST_ACTIVITY_LEAD_IN_DAYS);

  // MEDICAL REPS ONLY — the WHOLE board, both rules. Owner, 2026-09-07: "medical reps only i said".
  //
  // The silence rule was scoped this way from the start; the LEAVE rule was not, because his first
  // instruction was "every single employee who take five consecutive day vacations". Seeing it live
  // he corrected it: the board showed the Finance & Admin Manager, the National Sales Manager and
  // the Marketing Manager, each on five days of ordinary approved leave. Head-office leave is not a
  // retention signal — it is a holiday, already visible on the vacation report — and three such rows
  // out of seven is how a board stops being read.
  //
  // `logsOwnCrmVisitsTitle` is the same predicate the silence rule uses, so there is exactly one
  // definition of who this board is about.
  const employees = (await getEmployeeDirectoryRows())
    .filter(isActiveDirectoryEmployee)
    .filter((employee) => isRetentionRiskSubjectTitle(employee.jobTitle, employee.positionTitle));
  const repHrIds = employees.map((employee) => employee.hrId);

  const [leaveByHrId, crm, publicHolidays] = await Promise.all([
    loadLeaveDates(scanStart, window.end),
    loadCrmActivity(repHrIds, scanStart, window.measurableThrough).catch(() => null),
    getNationalHolidayDateSet(scanStart, window.end),
  ]);

  const subjects = buildSubjects(employees, crm?.firstSeen ?? new Map());

  // A CRM outage must not silently print an empty board — with no activity rows every rep reads as
  // silent, so the honest answer is to drop the silence half entirely and say why.
  //
  // THE SECOND CONDITION IS THE IMPORTANT ONE. A thrown error is the easy case; the dangerous case
  // is a read that SUCCEEDS and returns nothing, which is what an oversized `.in()` does here. Zero
  // rows across a 66-day scan of the whole field force is not a quiet quarter — production carries
  // roughly forty thousand — so it is a broken read every time, and treating it as data would name
  // every rep in the company at once.
  const crmUsable = crm !== null && (repHrIds.length === 0 || crm.rowCount > 0);
  const usableSubjects = crmUsable
    ? subjects
    : subjects.map((subject) => ({ ...subject, watchCrmSilence: false }));

  return {
    computedAt: nowIso,
    crmUnavailable: !crmUsable,
    measurableThrough: window.measurableThrough,
    signals: buildRetentionRiskSignals({
      crmActivityByHrId: crmUsable && crm ? crm.activity : new Map(),
      leaveByHrId,
      measurableThrough: window.measurableThrough,
      // "didnt return 2 work yet or seen" — owner, 2026-09-07. A closed run is a person who came
      // back; only an open one answers "who might resign this month". The scan window stays 45 days
      // so a run that began late last month is measured at its TRUE length rather than clipped to
      // the 1st, but nothing that has ended reaches the board.
      openRunsOnly: true,
      publicHolidays,
      subjects: usableSubjects,
      thresholdWorkingDays: RETENTION_RISK_THRESHOLD_WORKING_DAYS,
      windowEnd: window.end,
      windowStart: window.start,
    }),
    thresholdWorkingDays: RETENTION_RISK_THRESHOLD_WORKING_DAYS,
    windowEnd: window.end,
    windowStart: window.start,
  };
}

/**
 * Cached for the landing pages. Keyed on the Cairo DAY, so the cache turns over once a day at
 * Cairo midnight and the two-hour revalidate keeps it in step with the CRM sync's three daily
 * runs. Only the computed signals are cached, never the rows they came from.
 */
const computeRetentionRiskCached = unstable_cache(
  // The Cairo DAY is the only argument, and that is load-bearing rather than tidy: `unstable_cache`
  // keys on the arguments as well as on the key parts, so passing the current instant here would
  // make every single call a fresh key and the cache would never once be read — a 55,000-row mirror
  // scan on every landing-page render, with a cache in front of it that looked like it was working.
  async (dayKey: string) => {
    void dayKey;
    const view = await computeRetentionRisk(new Date().toISOString());
    // A board built while the CRM read failed is served to this one render and never kept. Cached,
    // a one-second blip would hide the whole silence half of the board for the next two hours.
    if (view.crmUnavailable) serveWithoutCaching(view, "the retention-risk CRM read failed");
    return view;
  },
  ["retention-risk-view"],
  { revalidate: CACHE_REVALIDATE_SECONDS, tags: ["retention-risk"] },
);

/** The board's data. Pass `fresh` for the sweep, which must never read a cached answer. */
export async function getRetentionRiskView(options: { fresh?: boolean } = {}): Promise<RetentionRiskView> {
  const now = new Date();
  if (options.fresh) return computeRetentionRisk(now.toISOString());
  return unwrapServedWithoutCaching(computeRetentionRiskCached(cairoDateIso(now)));
}
