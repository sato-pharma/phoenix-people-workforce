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

type SnapshotRow = {
  computed_at: string;
  employee_count: number;
  high_severity_count: number;
  month: number;
  month_key: string;
  preview?: FieldWorkforcePreviewResult;
  review_candidate_count: number;
  year: number;
};

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
