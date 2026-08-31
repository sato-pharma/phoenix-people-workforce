import { writeAuditLog } from "@/lib/admin/audit";
import { invalidateSalesDashboardCache } from "@/lib/dashboard/invalidation";
import { shiftPeriod } from "@/lib/sales/periods";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type {
  TerritorySyncReconciliationRow,
  TerritorySyncReport,
  TerritorySyncStatus,
} from "./types";

// The Territory Drilldown never looks back further than 12 months (see the area route's
// MAX_MONTHS_BACK), so the default Sync window matches: re-stamping older periods would mutate
// data no drilldown surface can show, for no benefit and more lock time.
export const TERRITORY_SYNC_DEFAULT_MONTHS = 12;
export const TERRITORY_SYNC_MAX_MONTHS = 24;

// A rollup rebuilt from import_rows must match the raw source exactly; this tolerance only absorbs
// floating-point noise in the effective-units product (qty * (1 - discount)).
const RECONCILE_EPSILON = 0.01;

// The whole sync (re-stamp + every affected batch's rollup rebuild) runs server-side in ONE
// transaction (phx_sync_sos_run), so it needs a request timeout far longer than the 15s default —
// a large first backlog can take a minute. Because it is one transaction, a client abort rolls the
// whole thing back rather than leaving import_rows re-stamped but rollups stale (the 2026-08-09
// half-applied-timeout incident).
const SYNC_REQUEST_TIMEOUT_MS = 170_000;

const AUDIT_ENTITY_TYPE = "territory_sync";

function currentPeriod(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The trailing window of period keys (oldest first), e.g. ["2025-09", …, "2026-08"]. Pure. */
export function computeSyncPeriods(monthsBack: number, now: Date = new Date()): string[] {
  const bounded = Math.max(1, Math.min(TERRITORY_SYNC_MAX_MONTHS, Math.trunc(monthsBack) || 0));
  const base = currentPeriod(now);
  const periods: string[] = [];
  for (let offset = bounded - 1; offset >= 0; offset--) {
    const period = shiftPeriod(base, offset);
    if (period) periods.push(period);
  }
  return periods;
}

type RawReconciliationRow = {
  official_line: string | null;
  period: string | null;
  rollup_total_qty: number | string | null;
  raw_total_qty: number | string | null;
  rollup_effective_units: number | string | null;
  raw_effective_units: number | string | null;
  rollup_row_count: number | string | null;
  raw_row_count: number | string | null;
  // Optional because a database still on the pre-2026-08-31 function does not return them. Absent
  // is NOT the same as zero: it means geography was never checked, which parseReconciliationRow
  // reports as geographyChecked=false rather than silently passing.
  geo_mismatch_rows?: number | string | null;
  unrollup_rows?: number | string | null;
};

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Map one reconciliation RPC row into the typed shape and decide whether it reconciles. Pure and
 * unit-tested directly: units/qty must agree within epsilon, the row counts must match exactly (an
 * integer count that differs by even one means a row was dropped or double-counted), AND no row may
 * sit on different geography than the rollup row summarising it. Kept separate from the DB call so
 * the reconcile verdict can be tested without a live database.
 *
 * The geography clause is the point. The re-stamp updates ONLY brick_id/area_code/area_name/
 * region_code/region_name, so total_qty, effective_units and row_count are invariant under it — a
 * quantity-only verdict could never fail for any geography, right or wrong. Measured on production
 * 2026-08-31: 4,265 rows carried a brick their own rollup row disagreed with, and this verdict
 * returned true for 11 of the 12 line-periods containing them.
 */
export function parseReconciliationRow(row: RawReconciliationRow): TerritorySyncReconciliationRow {
  const rollupTotalQty = toNumber(row.rollup_total_qty);
  const rawTotalQty = toNumber(row.raw_total_qty);
  const rollupEffectiveUnits = toNumber(row.rollup_effective_units);
  const rawEffectiveUnits = toNumber(row.raw_effective_units);
  const rollupRowCount = toNumber(row.rollup_row_count);
  const rawRowCount = toNumber(row.raw_row_count);
  // Absent (pre-migration database) is distinguished from zero: undefined/null means the geography
  // proof did not run, so it must not be reported as a passing geography check.
  const geographyChecked = row.geo_mismatch_rows !== undefined && row.geo_mismatch_rows !== null;
  const geoMismatchRows = toNumber(row.geo_mismatch_rows);
  const unrollupRows = toNumber(row.unrollup_rows);
  const reconciled =
    Math.abs(rollupTotalQty - rawTotalQty) < RECONCILE_EPSILON &&
    Math.abs(rollupEffectiveUnits - rawEffectiveUnits) < RECONCILE_EPSILON &&
    rollupRowCount === rawRowCount &&
    geoMismatchRows === 0 &&
    unrollupRows === 0;
  return {
    officialLine: (row.official_line ?? "Unknown").trim() || "Unknown",
    period: (row.period ?? "").trim(),
    rollupTotalQty,
    rawTotalQty,
    rollupEffectiveUnits,
    rawEffectiveUnits,
    rollupRowCount,
    rawRowCount,
    geoMismatchRows,
    unrollupRows,
    geographyChecked,
    reconciled,
  };
}

/**
 * Re-stamp every historical import row to today's geography (from the active customer map),
 * rebuild the rollups for exactly the batches that moved, then prove the drilldown's rollup now
 * equals the raw source.
 *
 * The re-stamp AND the rollup rebuilds run inside one server-side function (phx_sync_sos_run) —
 * therefore one transaction and one round trip. That is what makes it safe: a client timeout on a
 * large backlog rolls the whole thing back instead of committing the re-stamp but not the rollup
 * refresh (the half-applied state the earlier per-call orchestration left on 2026-08-09). It
 * mutates shared Source-of-Sales data the monthly closing also reads; the API route decides who
 * may run it.
 */
export async function syncTerritoryData(input: {
  periods: string[];
  actorLoginId: string;
}): Promise<TerritorySyncReport> {
  const startedAt = Date.now();
  const periods = input.periods;

  // 1) Re-stamp + rebuild the affected batches' rollups atomically, server-side, in one call. The
  //    long request timeout matches the function's own statement_timeout; because it is one
  //    transaction, an abort cannot leave a half-applied state.
  const runClient = getSupabaseAdmin({ requestTimeoutMs: SYNC_REQUEST_TIMEOUT_MS });
  const { data: runData, error: runError } = await runClient.rpc("phx_sync_sos_run", {
    p_periods: periods,
  });
  if (runError) {
    throw new Error(`Territory sync failed: ${runError.message}`);
  }
  const runRow = (Array.isArray(runData) ? runData[0] : runData) as
    | { restamped_rows?: number; refreshed_batches?: number }
    | null
    | undefined;
  const restampedRows = toNumber(runRow?.restamped_rows);
  const refreshedBatches = toNumber(runRow?.refreshed_batches);

  const supabase = getSupabaseAdmin();

  // 2) Read-only reconciliation proof across the same window.
  const { data: reconData, error: reconError } = await supabase.rpc("phx_sync_sos_reconciliation", {
    p_periods: periods,
  });
  if (reconError) {
    throw new Error(`Territory sync completed the re-stamp but the reconciliation check failed: ${reconError.message}`);
  }
  const reconciliation = ((reconData ?? []) as RawReconciliationRow[])
    .map(parseReconciliationRow)
    .filter((row) => row.period)
    .sort((a, b) =>
      a.officialLine === b.officialLine
        ? b.period.localeCompare(a.period)
        : a.officialLine.localeCompare(b.officialLine),
    );
  const allReconciled = reconciliation.every((row) => row.reconciled);
  // Totalled for the audit row and the summary line: a verdict of "not reconciled" is only
  // actionable if it says how much is off and in which direction.
  const geoMismatchRows = reconciliation.reduce((sum, row) => sum + row.geoMismatchRows, 0);
  const unrollupRows = reconciliation.reduce((sum, row) => sum + row.unrollupRows, 0);
  const geographyChecked = reconciliation.every((row) => row.geographyChecked);

  if (restampedRows > 0) {
    invalidateSalesDashboardCache(`territory sync — ${restampedRows} row(s) re-stamped`);
  }

  const syncedAt = new Date().toISOString();
  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: "source_of_sales_import_rows",
    entityType: AUDIT_ENTITY_TYPE,
    newValues: {
      periods,
      restamped_rows: restampedRows,
      refreshed_batches: refreshedBatches,
      all_reconciled: allReconciled,
      geo_mismatch_rows: geoMismatchRows,
      unrollup_rows: unrollupRows,
      geography_checked: geographyChecked,
      synced_at: syncedAt,
    },
    summary:
      `Territory sync: re-stamped ${restampedRows} row(s), rebuilt ${refreshedBatches} batch(es), ` +
      `reconciled=${allReconciled}` +
      (geographyChecked
        ? `, geography off on ${geoMismatchRows} row(s), ${unrollupRows} row(s) with no rollup row.`
        : " — geography NOT checked (database still on the quantity-only reconciliation function)."),
  });

  return {
    periods,
    restampedRows,
    refreshedBatches,
    reconciliation,
    allReconciled,
    durationMs: Date.now() - startedAt,
    syncedAt,
  };
}

/**
 * The last-sync metadata behind the drilldown's read-only freshness badge — sourced from the
 * audit trail the sync itself writes, so it needs no extra table.
 */
export async function getTerritorySyncStatus(): Promise<TerritorySyncStatus> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("audit_logs")
    .select("actor_login_id,new_values,created_at")
    .eq("entity_type", AUDIT_ENTITY_TYPE)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    return { lastSyncedAt: null, lastSyncedBy: null, lastRestampedRows: null, lastAllReconciled: null };
  }
  const row = data as { actor_login_id?: string | null; new_values?: Record<string, unknown> | null; created_at?: string | null };
  const values = row.new_values ?? {};
  const restamped = values.restamped_rows;
  const reconciled = values.all_reconciled;
  return {
    lastSyncedAt: row.created_at ?? null,
    lastSyncedBy: row.actor_login_id ?? null,
    lastRestampedRows: typeof restamped === "number" ? restamped : null,
    lastAllReconciled: typeof reconciled === "boolean" ? reconciled : null,
  };
}
