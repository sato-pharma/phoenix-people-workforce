/**
 * Field Workforce Compliance's "live" (non-Excel) data path. Every read here computes fresh
 * from the ireports360_visits mirror on every call — buildFieldWorkforceCompliancePreviewFromVisitsReport
 * (in ireports360-source.ts) is the underlying compute primitive, called directly, every time.
 *
 * There is deliberately NO cache/snapshot table backing this anymore (owner decision
 * 2026-07-18: WFC only ever reads CRM/visits data from the Phoenix CRM module, never a
 * point-in-time copy of it) — a month's numbers always reflect the mirror as it stands right
 * now, including past months (a later correction to historical visit data is reflected
 * immediately, everywhere, rather than requiring a manual re-save). The trade-off is cost: a
 * month view rescans that month's full visits_mirror range every time, and the 6-month
 * employee trend below does that six times over. Both are already narrow, permission-gated
 * admin surfaces (not high-traffic), so this was accepted deliberately over caching.
 */

import { fieldWorkforceMonthKey } from "@/lib/field-workforce-compliance/archive";
import { buildFieldWorkforceCompliancePreviewFromVisitsReport } from "@/lib/field-workforce-compliance/ireports360-source";
import type { FieldWorkforcePreviewResult } from "@/lib/field-workforce-compliance/types";
import { canonicalHrIdKey } from "@/lib/hr-id";

/**
 * Africa/Cairo calendar day (YYYY-MM-DD) for `at` — the company's business day, never UTC.
 *
 * Cairo is UTC+3, so for the ~3 hours after Cairo midnight a UTC date reads one day behind. Every
 * use below is either a "now" the owner sees or a value compared against Cairo wall-clock CRM
 * data. Kept local to this module by the same convention as drain-health-alert.ts and
 * job-heartbeat-alert.ts, which each carry their own one-liner rather than sharing a date module.
 */
function cairoDateIso(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(at);
}

export type FieldWorkforceLiveViewResult = {
  /** Always "now" — there is no separate compute time to track anymore. */
  computedAt: string;
  employeeCount: number;
  highSeverityCount: number;
  month: number;
  monthKey: string;
  preview: FieldWorkforcePreviewResult;
  reviewCandidateCount: number;
  year: number;
};

/**
 * Freshness of the underlying visits mirror for a given month, so the decision surface can
 * warn when the data a view was computed from may be incomplete. `isStale` trips when the
 * last successful visits sync is older than the threshold (the sync runs ~3×/day, so >26h
 * means several missed cycles). `isOpenMonth` marks the current calendar month, whose latest
 * days are still filling in — a legitimate reason "N" days may not yet be real absences.
 */
export type FieldWorkforceMirrorFreshness = {
  ageHours: number | null;
  isOpenMonth: boolean;
  isStale: boolean;
  lastSyncedAt: string | null;
  latestStatus: string | null;
};

export const FIELD_WORKFORCE_MIRROR_STALE_THRESHOLD_HOURS = 26;

/** Pure freshness summary from the visits-report sync-run history. Exported for unit tests. */
export function summarizeFieldWorkforceMirrorFreshness(input: {
  monthKey: string;
  nowIso: string;
  runs: Array<{ completedAt: string | null; startedAt: string; status: string }>;
  /** True once the CRM cutover has retired iReports360. Phoenix then records visits directly, so an
   * old last sync is the designed state and never makes the data stale. */
  vendorSyncRetired?: boolean;
}): FieldWorkforceMirrorFreshness {
  const latestSuccess = input.runs.find((run) => run.status === "success") ?? null;
  const lastSyncedAt = latestSuccess?.completedAt ?? latestSuccess?.startedAt ?? null;
  const nowMs = new Date(input.nowIso).getTime();
  const ageHours = lastSyncedAt
    ? Math.max(0, Math.round(((nowMs - new Date(lastSyncedAt).getTime()) / 3_600_000) * 10) / 10)
    : null;
  const isStale =
    !input.vendorSyncRetired && (ageHours == null || ageHours > FIELD_WORKFORCE_MIRROR_STALE_THRESHOLD_HOURS);
  // Which month is "open" is a CAIRO calendar question. Slicing the UTC month out of nowIso got
  // this wrong for the ~3 hours after every Cairo midnight, and at a month rollover it got it
  // backwards: the "still filling in" warning would sit on the previous month while HR was
  // looking at the new one. `nowIso` itself stays a true instant — ageHours above needs it.
  const isOpenMonth = input.monthKey === cairoDateIso(new Date(input.nowIso)).slice(0, 7);
  const latestStatus = input.runs[0]?.status ?? null;
  return { ageHours, isOpenMonth, isStale, lastSyncedAt, latestStatus };
}

/**
 * Compact per-employee-per-month projection of a full preview — used only to build the
 * 6-month employee trend without threading the whole (much larger) preview through it.
 */
export type FieldWorkforceEmployeeMonthRollup = {
  compliancePercent: number | null;
  employeeName: string;
  highSeverityCount: number;
  hrId: string;
  matchStatus: "matched" | "unmatched";
  noActivityCandidates: number;
};

/** Pure — exported for direct unit testing. */
export function buildEmployeeRollup(preview: FieldWorkforcePreviewResult): FieldWorkforceEmployeeMonthRollup[] {
  return preview.employees.map((employee) => ({
    compliancePercent: employee.compliancePercent,
    employeeName: employee.employeeName,
    highSeverityCount: employee.severityCounts.High,
    hrId: employee.hrId,
    matchStatus: employee.matchStatus,
    noActivityCandidates: employee.noActivityCandidates,
  }));
}

/** Computes one month live from the CRM visits mirror. This is the only read path — there is
 * nothing to cache, refresh, or force-refresh; every call recomputes. */
export async function getFieldWorkforceComplianceLiveView(input: {
  monthKey: string;
}): Promise<FieldWorkforceLiveViewResult> {
  const [yearStr, monthStr] = input.monthKey.split("-");
  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10);
  // Africa/Cairo, not UTC. This feeds ireports360-source.ts's not-yet-ended cutoff (today and
  // later are never judged), and the visit dates it is compared against are stored as Cairo
  // wall-clock. A UTC "today" runs a day behind for the ~3 hours after Cairo midnight, which would
  // hold back yesterday — a finished day — as not yet ended.
  const todayIso = cairoDateIso();
  const preview = await buildFieldWorkforceCompliancePreviewFromVisitsReport({ month, todayIso, year });
  // A true INSTANT, deliberately — a timestamp, not a calendar day, and it carries its own `Z`.
  // Not a Cairo case: do not "fix" this one to a local string.
  const computedAt = new Date().toISOString();

  return {
    computedAt,
    employeeCount: preview.metadata.employeeCount,
    highSeverityCount: preview.severityCounts.High,
    month: preview.metadata.month,
    monthKey: fieldWorkforceMonthKey(preview.metadata.year, preview.metadata.month),
    preview,
    reviewCandidateCount: preview.reviewCandidates.length,
    year: preview.metadata.year,
  };
}

export type FieldWorkforceLiveMonthOption = {
  month: number;
  monthKey: string;
  year: number;
};

/**
 * Plain list of recent calendar months (current + monthsBack previous), newest first — pure
 * calendar math, no DB read and no per-month computation. Populates the month picker without
 * paying to recompute every listed month just to render a dropdown; a specific month's real
 * numbers are only computed when the caller actually selects it via getFieldWorkforceComplianceLiveView.
 */
export function listRecentFieldWorkforceComplianceMonths(input: {
  monthsBack?: number;
  todayIso?: string;
} = {}): FieldWorkforceLiveMonthOption[] {
  const monthsBack = input.monthsBack ?? 12;
  // The UTC anchor is deliberate and stays: `todayIso` is a DATE-ONLY value, so parsing it at UTC
  // midnight and reading it back with getUTC* is exactly what stops the calendar day shifting.
  // Only the DEFAULT was wrong — a bare `new Date()` read the clock in UTC, so on the 1st of a
  // month between Cairo midnight and 03:00 the newest option was still LAST month: the current
  // month was missing from the picker entirely.
  const today = new Date(`${input.todayIso ?? cairoDateIso()}T00:00:00Z`);
  let year = today.getUTCFullYear();
  let month = today.getUTCMonth() + 1;

  const options: FieldWorkforceLiveMonthOption[] = [];
  for (let i = 0; i <= monthsBack; i += 1) {
    options.push({ month, monthKey: fieldWorkforceMonthKey(year, month), year });
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }
  return options;
}

export type FieldWorkforceEmployeeTrendPoint = {
  compliancePercent: number | null;
  highSeverityCount: number;
  matchStatus: "matched" | "unmatched";
  monthKey: string;
  noActivityCandidates: number;
};

export type FieldWorkforceEmployeeTrend = {
  /** Count of months (within the ones considered) where this employee had a High-severity day
   * — a displayed fact only, never an automatic severity escalation. */
  highSeverityMonthCount: number;
  monthsConsidered: number;
  points: FieldWorkforceEmployeeTrendPoint[];
};

/**
 * Pure — exported for direct unit testing. Extracts one employee's points from a set of
 * already-computed month rollups (newest-first) and reverses to oldest -> newest (natural
 * chart/reading order). A month whose rollup has no entry for this employee (they didn't exist
 * that month, or that month failed to compute) is silently skipped, not treated as a
 * zero/absent month.
 */
export function computeEmployeeTrendFromRows(
  rows: Array<{ employee_rollup: FieldWorkforceEmployeeMonthRollup[] | null; month_key: string }>,
  hrId: string,
): FieldWorkforceEmployeeTrend {
  const hrKey = canonicalHrIdKey(hrId);
  const points: FieldWorkforceEmployeeTrendPoint[] = [];
  for (const row of rows) {
    const entry = (row.employee_rollup ?? []).find((item) => canonicalHrIdKey(item.hrId) === hrKey);
    if (!entry) continue;
    points.push({
      compliancePercent: entry.compliancePercent,
      highSeverityCount: entry.highSeverityCount,
      matchStatus: entry.matchStatus,
      monthKey: row.month_key,
      noActivityCandidates: entry.noActivityCandidates,
    });
  }
  points.reverse();

  return {
    highSeverityMonthCount: points.filter((point) => point.highSeverityCount > 0).length,
    monthsConsidered: points.length,
    points,
  };
}

/**
 * One employee's compliance history across the trailing N months, EVERY month recomputed live
 * from the CRM visits mirror (owner decision — no cached history table). A month that fails to
 * compute (e.g. the mirror has no data that far back) is skipped rather than failing the whole
 * trend, matching the old "not yet backfilled" behavior.
 */
export async function getFieldWorkforceComplianceEmployeeTrend(input: {
  hrId: string;
  monthsBack?: number;
}): Promise<FieldWorkforceEmployeeTrend> {
  const monthsBack = input.monthsBack ?? 6;
  const months = listRecentFieldWorkforceComplianceMonths({ monthsBack: monthsBack - 1 });
  // Africa/Cairo, not UTC — same future-day cutoff as getFieldWorkforceComplianceLiveView above.
  const todayIso = cairoDateIso();

  const rows = await Promise.all(
    months.map(async ({ month, monthKey, year }) => {
      try {
        const preview = await buildFieldWorkforceCompliancePreviewFromVisitsReport({ month, todayIso, year });
        return { employee_rollup: buildEmployeeRollup(preview), month_key: monthKey };
      } catch {
        return { employee_rollup: null, month_key: monthKey };
      }
    }),
  );

  return computeEmployeeTrendFromRows(rows, input.hrId);
}
