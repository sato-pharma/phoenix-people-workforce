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

// Refresh the rollups for at most this many batches at once. The re-stamp usually touches a
// handful of batches; the cap stops a rare wide sync (e.g. a mass brick move) from firing dozens
// of concurrent RPCs at a database every round trip already crosses the Atlantic to reach.
const REFRESH_CONCURRENCY = 4;

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
};

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Map one reconciliation RPC row into the typed shape and decide whether it reconciles. Pure and
 * unit-tested directly: units/qty must agree within epsilon and the row counts must match exactly
 * (an integer count that differs by even one means a row was dropped or double-counted). Kept
 * separate from the DB call so the reconcile verdict can be tested without a live database.
 */
export function parseReconciliationRow(row: RawReconciliationRow): TerritorySyncReconciliationRow {
  const rollupTotalQty = toNumber(row.rollup_total_qty);
  const rawTotalQty = toNumber(row.raw_total_qty);
  const rollupEffectiveUnits = toNumber(row.rollup_effective_units);
  const rawEffectiveUnits = toNumber(row.raw_effective_units);
  const rollupRowCount = toNumber(row.rollup_row_count);
  const rawRowCount = toNumber(row.raw_row_count);
  const reconciled =
    Math.abs(rollupTotalQty - rawTotalQty) < RECONCILE_EPSILON &&
    Math.abs(rollupEffectiveUnits - rawEffectiveUnits) < RECONCILE_EPSILON &&
    rollupRowCount === rawRowCount;
  return {
    officialLine: (row.official_line ?? "Unknown").trim() || "Unknown",
    period: (row.period ?? "").trim(),
    rollupTotalQty,
    rawTotalQty,
    rollupEffectiveUnits,
    rawEffectiveUnits,
    rollupRowCount,
    rawRowCount,
    reconciled,
  };
}

/** Chunk an array into fixed-size groups. Pure. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Re-stamp every historical import row to today's geography (from the active customer map),
 * rebuild the rollups for exactly the batches that moved, then prove the drilldown's rollup now
 * equals the raw source. This is the bulk, set-based sibling of applyHistoricalReconciliation
 * (normalizer/customer-map.ts) — same re-stamp columns, same refresh trio — run once across all
 * mappings instead of once per customer.
 *
 * Mutates shared Source-of-Sales data that the monthly closing also reads, so the caller MUST
 * gate this to the admin account (see the API route). Throws if a rollup refresh fails, so a
 * partial, inconsistent state is never left silently in place.
 */
export async function syncTerritoryData(input: {
  periods: string[];
  actorLoginId: string;
}): Promise<TerritorySyncReport> {
  const startedAt = Date.now();
  const supabase = getSupabaseAdmin();
  const periods = input.periods;

  // 1) Set-based re-stamp of import_rows from the active customer_map.
  const { data: restampData, error: restampError } = await supabase.rpc(
    "phx_sync_sos_restamp_import_rows",
    { p_periods: periods },
  );
  if (restampError) {
    throw new Error(`Territory sync failed while re-stamping geography: ${restampError.message}`);
  }
  const restampRow = (Array.isArray(restampData) ? restampData[0] : restampData) as
    | { updated_rows?: number; affected_batch_ids?: unknown }
    | null
    | undefined;
  const restampedRows = toNumber(restampRow?.updated_rows);
  const affectedBatchIds = Array.isArray(restampRow?.affected_batch_ids)
    ? restampRow!.affected_batch_ids.map((id) => String(id)).filter(Boolean)
    : [];

  // 2) Rebuild the canonical refresh trio for exactly the touched batches — refreshing all three
  //    (not just the two the drilldown reads) keeps the monthly closing and marketing ROI facts
  //    consistent with the moved geography instead of introducing a fresh skew.
  let refreshedBatches = 0;
  for (const group of chunk(affectedBatchIds, REFRESH_CONCURRENCY)) {
    await Promise.all(
      group.map(async (batchId) => {
        const [fact, directory, roi] = await Promise.all([
          supabase.rpc("phx_refresh_sos_fact_rollup", { p_batch_id: batchId }),
          supabase.rpc("phx_refresh_sos_customer_directory_rollup", { p_batch_id: batchId }),
          supabase.rpc("phx_refresh_marketing_roi_facts", { p_batch_id: batchId }),
        ]);
        const rollupError = fact.error ?? directory.error ?? roi.error;
        if (rollupError) {
          throw new Error(
            `Territory sync re-stamped ${restampedRows} row(s) but rollup refresh failed for batch ${batchId}: ${rollupError.message}. Re-run Sync to retry.`,
          );
        }
      }),
    );
    refreshedBatches += group.length;
  }

  // 3) Read-only reconciliation proof across the same window.
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
      synced_at: syncedAt,
    },
    summary: `Territory sync: re-stamped ${restampedRows} row(s), rebuilt ${refreshedBatches} batch(es), reconciled=${allReconciled}.`,
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
