import { logInfo } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { computeSyncPeriods, syncTerritoryData, TERRITORY_SYNC_DEFAULT_MONTHS } from "./sync";

/**
 * The scheduled half of the Territory Sync.
 *
 * WHY THIS EXISTS. `syncTerritoryData` re-stamps historical Source-of-Sales rows to today's
 * geography and rebuilds the rollups of exactly the batches that moved — the owner's standing rule
 * that all SoS sales, historical and future, attribute to TODAY's geography. Until now its only
 * trigger was a human pressing Sync in the Territory Drilldown. That is the wrong shape for a rule
 * that must always hold, because the thing which breaks it is invisible: inserting one employee
 * auto-fills a vacant seat and flips `line_area_map.area_state`, which staled 8 of 8 periods off 3
 * inserts with no error at all — the numbers simply stop coming from the rollup. Nobody presses a
 * button they were never told to press.
 *
 * WHY IT IS NOT SIMPLY THE BUTTON ON A TIMER. Publishing a monthly closing does NOT freeze its
 * figures: `monthly_closing_publications` carries `snapshot_units` / `snapshot_cells` columns, and
 * on 2026-08-29 every published row had them NULL. A re-stamp of a published period therefore
 * moves numbers underneath a closing that has already been sent — silently, at 02:00, with nobody
 * watching. There is also a standing instruction on record that Pedia and Anti-Infective July must
 * not be re-stamped, and July is published.
 *
 * So the scheduled run carries one guard the button does not: IT NEVER TOUCHES A PUBLISHED PERIOD.
 * A published month stays exactly as it was published, and correcting one remains a deliberate
 * human act through the existing Drilldown button. Everything still open is kept correct nightly.
 *
 * Measured against production on 2026-08-29: 260 rows across 8 batches were drifted, all of them in
 * 2026-07 — the one published period — so this job's first run re-stamps nothing and reports the
 * skip. That is the intended behaviour, not a failure to do work.
 *
 * The run is idempotent (only rows whose brick actually moved are written; a second run writes
 * nothing) and cheap at rest: `phx_sync_sos_run` refreshes rollups only for batches it actually
 * moved, so a no-op run is a single indexed scan. The read-only reconciliation across a full
 * 12-month window measured 1.19s.
 */

/** Audit actor for a scheduled run, so the audit trail separates it from a human pressing Sync. */
export const SCHEDULED_TERRITORY_SYNC_ACTOR = "system:cron-territory-restamp";

export type ScheduledTerritorySyncResult = {
  /** The full trailing window considered, oldest first. */
  window: string[];
  /** Periods withheld because a closing has been published for them. Never re-stamped here. */
  publishedPeriodsSkipped: string[];
  /** The periods actually passed to the re-stamp. */
  syncedPeriods: string[];
  restampedRows: number;
  refreshedBatches: number;
  /** Null when nothing was eligible, so "no run" is never reported as "reconciled". */
  allReconciled: boolean | null;
  /** True when every period in the window is published and the RPC was not called at all. */
  skippedEntirely: boolean;
  durationMs: number;
  ranAt: string;
};

/**
 * Every period with at least one published closing line.
 *
 * Deliberately period-granular, not (period, line): `phx_sync_sos_run` takes periods only, so a
 * period with ANY line published must be withheld whole. Withholding too much is a stale open
 * period a human can fix; withholding too little rewrites a sent closing.
 */
export async function listPublishedClosingPeriods(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("monthly_closing_publications").select("period");
  if (error) {
    // Fail CLOSED. If we cannot prove which periods are published we must not re-stamp anything —
    // the whole safety property of this job is that it never moves a published closing.
    throw new Error(`Territory re-stamp aborted: could not read published closings (${error.message}).`);
  }
  const periods = new Set<string>();
  for (const row of data ?? []) {
    const period = String((row as { period?: unknown }).period ?? "").trim();
    if (period) periods.add(period);
  }
  return [...periods].sort();
}

/**
 * The periods a scheduled run may touch: the window minus every published period.
 *
 * Pure and directly unit-tested — this single line is the entire safety guarantee, so it is kept
 * out of the database call so it can be proven without one.
 */
export function selectUnpublishedPeriods(
  window: readonly string[],
  publishedPeriods: Iterable<string>,
): string[] {
  const published = new Set<string>();
  for (const value of publishedPeriods) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) published.add(trimmed);
  }
  return window.filter((period) => !published.has(String(period ?? "").trim()));
}

/**
 * Re-stamp every OPEN period in the trailing window to today's geography.
 *
 * `monthsBack` matches the Drilldown's own default window; a caller may narrow it, and
 * `computeSyncPeriods` clamps it to TERRITORY_SYNC_MAX_MONTHS.
 */
export async function runScheduledTerritorySync(
  options: { monthsBack?: number; now?: Date } = {},
): Promise<ScheduledTerritorySyncResult> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const window = computeSyncPeriods(options.monthsBack ?? TERRITORY_SYNC_DEFAULT_MONTHS, now);

  const published = await listPublishedClosingPeriods();
  const syncedPeriods = selectUnpublishedPeriods(window, published);
  const publishedPeriodsSkipped = window.filter((period) => !syncedPeriods.includes(period));

  if (syncedPeriods.length === 0) {
    logInfo("Territory re-stamp skipped — every period in the window is a published closing", {
      labels: { event: "territory_restamp_skipped", job: "territory-restamp" },
      context: { window, publishedPeriodsSkipped },
    });
    return {
      window,
      publishedPeriodsSkipped,
      syncedPeriods,
      restampedRows: 0,
      refreshedBatches: 0,
      allReconciled: null,
      skippedEntirely: true,
      durationMs: Date.now() - startedAt,
      ranAt: new Date().toISOString(),
    };
  }

  const report = await syncTerritoryData({
    periods: syncedPeriods,
    actorLoginId: SCHEDULED_TERRITORY_SYNC_ACTOR,
  });

  // Log at INFO whenever the job actually moved rows. A scheduled re-stamp that changes numbers is
  // something a human should be able to find afterwards without reading the audit table — and it
  // is the only trace, because this job deliberately notifies nobody.
  if (report.restampedRows > 0) {
    logInfo("Territory re-stamp moved rows to today's geography", {
      labels: { event: "territory_restamp_applied", job: "territory-restamp" },
      context: {
        restampedRows: report.restampedRows,
        refreshedBatches: report.refreshedBatches,
        periods: syncedPeriods,
        allReconciled: report.allReconciled,
      },
    });
  }

  return {
    window,
    publishedPeriodsSkipped,
    syncedPeriods,
    restampedRows: report.restampedRows,
    refreshedBatches: report.refreshedBatches,
    allReconciled: report.allReconciled,
    skippedEntirely: false,
    durationMs: Date.now() - startedAt,
    ranAt: report.syncedAt,
  };
}
