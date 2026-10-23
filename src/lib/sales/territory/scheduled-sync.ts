import { logError, logInfo } from "@/lib/observability/log";
import { type ManagerAreaFinding, describeManagerAreaDrift } from "@/lib/org/manager-area-region";
import { findManagerAreaDrift } from "@/lib/org/manager-area-region-check";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  computeSyncPeriods,
  syncTerritoryData,
  TERRITORY_SYNC_DEFAULT_MONTHS,
  TERRITORY_SYNC_SCHEDULED_BUDGET_MS,
} from "./sync";

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
  /**
   * Sales managers recorded against one of their own rep areas, and regions with no area row for a
   * manager to point at. Empty means the geography is clean. `managerAreaCheckRan: false` means the
   * read failed and NOTHING is known — deliberately a different answer from "clean", because a
   * check that cannot run is the one state that reads as healthy in every report that counts rows.
   */
  managerAreaFindings: ManagerAreaFinding[];
  managerAreaCheckRan: boolean;
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
  // EVER published, deliberately — no `unpublished_at is null` filter here, unlike every
  // visibility reader. A month that was published and later withdrawn was still SENT, and its
  // numbers are still in someone's inbox; re-stamping its territories afterwards would rewrite a
  // closing people already have. Withholding too much is a stale open period a human can fix.
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

/** The trailing window, split into what a re-stamp may touch and what it must leave alone. */
export type SyncablePeriodWindow = {
  /** The full trailing window considered, oldest first. */
  window: string[];
  /** The periods a re-stamp may touch. NEVER pass an empty array on to the RPC — see below. */
  syncablePeriods: string[];
  /** Periods withheld because a closing has been published for them. */
  publishedPeriodsSkipped: string[];
};

/**
 * Resolve the window and withhold every published period. THE ONE DEFINITION OF THE GUARD.
 *
 * WHY IT IS SHARED, AND NOT A SECOND COPY. Until 2026-09-22 this guard lived only in
 * `runScheduledTerritorySync`, and the Drilldown's own Sync button called `syncTerritoryData` with
 * the raw window — so the button asked to re-stamp published months that the nightly job is
 * forbidden to touch. Nothing was corrupted, because `trg_lock_guard_upd` on
 * `source_of_sales_import_rows` raises on a locked closing and rolls the whole transaction back;
 * the visible cost was the opposite one — since the 2026-09-14 locks the button simply FAILED for
 * every drilldown user, and the open months in the same window never got their re-stamp either,
 * because one RPC call carries every period in one transaction.
 *
 * The database lock and this guard are NOT the same rule and must not be mistaken for each other:
 * `monthly_closing_locks` is a switch the owner toggles, `monthly_closing_publications` is a
 * permanent record. A month that was published and later unlocked passes the trigger and still
 * must not be re-stamped — which is exactly the gap this function closes.
 */
export async function resolveSyncablePeriods(monthsBack?: number, now?: Date): Promise<SyncablePeriodWindow> {
  const window = computeSyncPeriods(monthsBack ?? TERRITORY_SYNC_DEFAULT_MONTHS, now);
  const published = await listPublishedClosingPeriods();
  const syncablePeriods = selectUnpublishedPeriods(window, published);
  const publishedPeriodsSkipped = window.filter((period) => !syncablePeriods.includes(period));
  return { window, syncablePeriods, publishedPeriodsSkipped };
}

/**
 * Re-stamp every OPEN period in the trailing window to today's geography.
 *
 * `monthsBack` matches the Drilldown's own default window; a caller may narrow it, and
 * `computeSyncPeriods` clamps it to TERRITORY_SYNC_MAX_MONTHS.
 */
export async function runScheduledTerritorySync(
  options: {
    monthsBack?: number;
    now?: Date;
    /**
     * Fired the moment the re-stamp COMMITS, so the cron route can report liveness before the
     * reconciliation-and-audit tail — which a production deploy cut on 2026-09-04, stranding a
     * run that had already done its work. NOT fired on the skip path below: that path commits
     * nothing, and the route reports its own success there instead.
     */
    onWorkCommitted?: () => Promise<void> | void;
  } = {},
): Promise<ScheduledTerritorySyncResult> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const {
    window,
    syncablePeriods: syncedPeriods,
    publishedPeriodsSkipped,
  } = await resolveSyncablePeriods(options.monthsBack, now);

  // Manager geography is checked on EVERY run, including the skip path below. It has nothing to do
  // with whether a period was re-stamped: a manager drifts onto a rep area the moment somebody
  // resigns and the replacement vacancy copies his area forward, which happens on nights when this
  // job re-stamps nothing at all. Gating it on work done would hide it for exactly as long as the
  // window stays published.
  const managerArea = await findManagerAreaDrift();
  const managerAreaSummary = describeManagerAreaDrift(managerArea.findings);
  if (managerAreaSummary) {
    // ERROR, not INFO: this is a wrong answer already on screen, not a note about work done. Every
    // board that groups people by area is showing a district manager occupying a rep's patch, and
    // the rep seat under him reads as covered when it is vacant.
    logError(managerAreaSummary, {
      labels: { event: "manager_area_region_drift", job: "territory-restamp" },
      context: { findings: managerArea.findings },
    });
  }

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
      managerAreaFindings: managerArea.findings,
      managerAreaCheckRan: managerArea.ran,
      durationMs: Date.now() - startedAt,
      ranAt: new Date().toISOString(),
    };
  }

  const report = await syncTerritoryData({
    periods: syncedPeriods,
    actorLoginId: SCHEDULED_TERRITORY_SYNC_ACTOR,
    // The nightly route may run 300 s; the button's 80 s budget would leave a slow night's
    // retry no room (`restampPeriodsOneByOne`).
    budgetMs: TERRITORY_SYNC_SCHEDULED_BUDGET_MS,
    onWorkCommitted: options.onWorkCommitted,
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
    managerAreaFindings: managerArea.findings,
    managerAreaCheckRan: managerArea.ran,
    durationMs: Date.now() - startedAt,
    ranAt: report.syncedAt,
  };
}
