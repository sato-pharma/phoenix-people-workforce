/**
 * Auto-maintained per-month Field Workforce Compliance snapshots, computed from the
 * ireports360_visits mirror. This is the primary read path for the admin UI (a fast DB
 * read instead of a live recompute on every view); buildFieldWorkforceCompliancePreviewFromVisitsReport
 * (in ireports360-source.ts) remains the underlying compute primitive this module calls to
 * produce/refresh a snapshot.
 *
 * Snapshots are written two ways:
 *  - refreshFieldWorkforceComplianceLiveSnapshotsForRange() is called after every visits-report
 *    sync (cron + manual backfill) for whichever month(s) that sync's date range touches, so
 *    "current" months stay continuously fresh.
 *  - A one-time historical backfill (scripts/_tmp-fwc-live-snapshots-backfill.ts) computes every
 *    month back to when the mirror's data starts.
 */

import { fieldWorkforceMonthKey } from "@/lib/field-workforce-compliance/archive";
import { buildFieldWorkforceCompliancePreviewFromVisitsReport } from "@/lib/field-workforce-compliance/ireports360-source";
import type { FieldWorkforcePreviewResult } from "@/lib/field-workforce-compliance/types";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const snapshotsTable = "field_workforce_compliance_live_snapshots";

export type FieldWorkforceLiveSnapshotListItem = {
  computedAt: string;
  employeeCount: number;
  highSeverityCount: number;
  month: number;
  monthKey: string;
  reviewCandidateCount: number;
  year: number;
};

export type FieldWorkforceLiveSnapshotDetail = FieldWorkforceLiveSnapshotListItem & {
  preview: FieldWorkforcePreviewResult;
};

/**
 * Freshness of the underlying visits mirror for a given month, so the decision surface can
 * warn when the data a snapshot was computed from may be incomplete. `isStale` trips when the
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
}): FieldWorkforceMirrorFreshness {
  const latestSuccess = input.runs.find((run) => run.status === "success") ?? null;
  const lastSyncedAt = latestSuccess?.completedAt ?? latestSuccess?.startedAt ?? null;
  const nowMs = new Date(input.nowIso).getTime();
  const ageHours = lastSyncedAt
    ? Math.max(0, Math.round(((nowMs - new Date(lastSyncedAt).getTime()) / 3_600_000) * 10) / 10)
    : null;
  const isStale = ageHours == null || ageHours > FIELD_WORKFORCE_MIRROR_STALE_THRESHOLD_HOURS;
  const isOpenMonth = input.monthKey === input.nowIso.slice(0, 7);
  const latestStatus = input.runs[0]?.status ?? null;
  return { ageHours, isOpenMonth, isStale, lastSyncedAt, latestStatus };
}

type SnapshotRow = {
  computed_at: string;
  employee_count: number;
  employee_rollup?: FieldWorkforceEmployeeMonthRollup[] | null;
  high_severity_count: number;
  month: number;
  month_key: string;
  preview?: FieldWorkforcePreviewResult;
  review_candidate_count: number;
  year: number;
};

/**
 * Compact per-employee-per-month rollup, persisted alongside (not instead of) the full
 * `preview` JSONB — a trend read across N months projects only this column, never the full
 * preview, so it stays cheap regardless of how many months are considered.
 */
export type FieldWorkforceEmployeeMonthRollup = {
  compliancePercent: number;
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

function toListItem(row: SnapshotRow): FieldWorkforceLiveSnapshotListItem {
  return {
    computedAt: row.computed_at,
    employeeCount: row.employee_count,
    highSeverityCount: row.high_severity_count,
    month: row.month,
    monthKey: row.month_key,
    reviewCandidateCount: row.review_candidate_count,
    year: row.year,
  };
}

/** Every distinct {month, year} touched by [dateFrom, dateTo], inclusive. Handles ranges
 * spanning a month boundary (or several, for a large manual backfill). */
export function monthsInDateRange(dateFrom: string, dateTo: string): Array<{ month: number; year: number }> {
  const months = new Map<string, { month: number; year: number }>();
  const cursor = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    months.set(`${year}-${month}`, { month, year });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
  }
  return [...months.values()];
}

/** Computes the month live from the mirror and upserts it as the saved snapshot. */
export async function saveFieldWorkforceComplianceLiveSnapshot(input: {
  month: number;
  year: number;
}): Promise<FieldWorkforceLiveSnapshotListItem> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const preview = await buildFieldWorkforceCompliancePreviewFromVisitsReport({
    month: input.month,
    todayIso,
    year: input.year,
  });
  const monthKey = fieldWorkforceMonthKey(preview.metadata.year, preview.metadata.month);
  const now = new Date().toISOString();

  const payload = {
    computed_at: now,
    employee_count: preview.metadata.employeeCount,
    employee_rollup: buildEmployeeRollup(preview),
    high_severity_count: preview.severityCounts.High,
    month: preview.metadata.month,
    month_key: monthKey,
    preview,
    review_candidate_count: preview.reviewCandidates.length,
    updated_at: now,
    year: preview.metadata.year,
  };

  const { error } = await getSupabaseAdmin()
    .from(snapshotsTable)
    .upsert(payload, { onConflict: "month_key" });
  if (error) throw error;

  return {
    computedAt: now,
    employeeCount: preview.metadata.employeeCount,
    highSeverityCount: preview.severityCounts.High,
    month: preview.metadata.month,
    monthKey,
    reviewCandidateCount: preview.reviewCandidates.length,
    year: preview.metadata.year,
  };
}

/**
 * Best-effort hook for after a visits mirror sync completes: recomputes and saves the FWC
 * snapshot for every month the synced date range touches. Never throws — a snapshot
 * recompute failure must not fail the visits sync that triggered it. Callers should log the
 * returned warnings if they care, but are not required to.
 */
export async function refreshFieldWorkforceComplianceLiveSnapshotsForRange(input: {
  dateFrom: string;
  dateTo: string;
}): Promise<{ refreshed: string[]; warnings: string[] }> {
  const refreshed: string[] = [];
  const warnings: string[] = [];
  let months: Array<{ month: number; year: number }> = [];
  try {
    months = monthsInDateRange(input.dateFrom, input.dateTo);
  } catch (error) {
    warnings.push(`Failed to determine months for range ${input.dateFrom}..${input.dateTo}: ${error instanceof Error ? error.message : String(error)}`);
    return { refreshed, warnings };
  }

  for (const { month, year } of months) {
    try {
      const snapshot = await saveFieldWorkforceComplianceLiveSnapshot({ month, year });
      refreshed.push(snapshot.monthKey);
    } catch (error) {
      warnings.push(`Failed to refresh Field Workforce Compliance snapshot for ${year}-${String(month).padStart(2, "0")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { refreshed, warnings };
}

export async function listFieldWorkforceComplianceLiveSnapshots(): Promise<FieldWorkforceLiveSnapshotListItem[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(snapshotsTable)
    .select("month_key, month, year, employee_count, high_severity_count, review_candidate_count, computed_at")
    .order("month_key", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as SnapshotRow[]).map(toListItem);
}

/** Reads the saved snapshot for a month. Self-heals: if none exists yet (e.g. a month
 * outside the automatic backfill/cron coverage), computes and saves it on the spot rather
 * than erroring, so the feature never appears broken for a valid but not-yet-cached month. */
export async function getFieldWorkforceComplianceLiveSnapshot(input: {
  forceRefresh?: boolean;
  monthKey: string;
}): Promise<FieldWorkforceLiveSnapshotDetail> {
  if (!input.forceRefresh) {
    const { data, error } = await getSupabaseAdmin()
      .from(snapshotsTable)
      .select("*")
      .eq("month_key", input.monthKey)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      const row = data as SnapshotRow;
      return { ...toListItem(row), preview: row.preview as FieldWorkforcePreviewResult };
    }
  }

  const [yearStr, monthStr] = input.monthKey.split("-");
  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10);
  const listItem = await saveFieldWorkforceComplianceLiveSnapshot({ month, year });
  const { data, error } = await getSupabaseAdmin()
    .from(snapshotsTable)
    .select("*")
    .eq("month_key", input.monthKey)
    .single();
  if (error) throw error;
  const row = data as SnapshotRow;
  return { ...listItem, preview: row.preview as FieldWorkforcePreviewResult };
}

export type FieldWorkforceEmployeeTrendPoint = {
  compliancePercent: number;
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
 * already-fetched snapshot rows (newest-first, as returned by the DB query) and reverses to
 * oldest -> newest (natural chart/reading order). A month whose employee_rollup has no entry
 * for this employee (not yet backfilled, or the employee didn't exist that month) is silently
 * skipped, not treated as a zero/absent month.
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
 * One employee's compliance history across the trailing N saved months — a cheap projection
 * of `employee_rollup` only, never the full `preview` JSONB.
 */
export async function getFieldWorkforceComplianceEmployeeTrend(input: {
  hrId: string;
  monthsBack?: number;
}): Promise<FieldWorkforceEmployeeTrend> {
  const monthsBack = input.monthsBack ?? 6;
  const { data, error } = await getSupabaseAdmin()
    .from(snapshotsTable)
    .select("month_key, employee_rollup")
    .order("month_key", { ascending: false })
    .limit(monthsBack);
  if (error) throw error;

  return computeEmployeeTrendFromRows(
    (data ?? []) as Array<{ employee_rollup: FieldWorkforceEmployeeMonthRollup[] | null; month_key: string }>,
    input.hrId,
  );
}
