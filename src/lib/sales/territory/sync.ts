import { writeAuditLog } from "@/lib/admin/audit";
import { invalidateSalesDashboardCache } from "@/lib/dashboard/invalidation";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
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
// floating-point noise in the effective-units product (qty x factory price).
const RECONCILE_EPSILON = 0.01;

// Each period's re-stamp (its rows + every affected batch's rollup rebuild) runs server-side in ONE
// transaction (phx_sync_sos_run), so it needs a request timeout far longer than the 15s default —
// a large first backlog can take a minute. Because it is one transaction, a client abort rolls the
// whole period back rather than leaving import_rows re-stamped but rollups stale (the 2026-08-09
// half-applied-timeout incident).
const SYNC_REQUEST_TIMEOUT_MS = 170_000;

/**
 * How long one sync may spend re-stamping, by caller. The nightly route may run 300 s and the
 * Drilldown button's route 120 s; each keeps about a minute back for the reconciliation read and the
 * audit row (the tail measured 24.3 s on 2026-09-03).
 */
export const TERRITORY_SYNC_SCHEDULED_BUDGET_MS = 240_000;
export const TERRITORY_SYNC_BUTTON_BUDGET_MS = 80_000;

/** A period is not started with less than this left: a no-op period answers in about a second. */
const MIN_START_MS = 10_000;
/** A cut period is tried once more only with this much left — a slow night ran about two minutes. */
const MIN_RETRY_MS = 60_000;

const AUDIT_ENTITY_TYPE = "territory_sync";

/**
 * Was the re-stamp call CUT — the database gateway, the statement timeout, the client's own abort or a
 * dropped connection — rather than refused? A cut rolls its one period back whole, so trying it again
 * is safe; a refusal (a locked closing's trigger, a missing function) would only be refused again.
 */
export function territorySyncCallWasCut(message: string): boolean {
  return /upstream request timeout|statement timeout|canceling statement|timed out|timeout|aborted|fetch failed|ECONNRESET|socket hang up|\b50[234]\b/i.test(
    message,
  );
}

export type TerritoryPeriodFailure = { period: string; message: string; attempts: number };

export type TerritoryRestampOutcome = {
  restampedRows: number;
  refreshedBatches: number;
  /** Periods whose re-stamp committed, in the order they ran. */
  committedPeriods: string[];
  /** Periods that failed, after one more try when the failure was a cut and time allowed. */
  failedPeriods: TerritoryPeriodFailure[];
  /** Periods never started because the run's time was spent — the next run takes them. */
  notReachedPeriods: string[];
};

/** The periods a run left for the next one, in words — empty when every period committed. Pure. */
export function unfinishedSummary(
  outcome: Pick<TerritoryRestampOutcome, "failedPeriods" | "notReachedPeriods" | "committedPeriods">,
): string {
  const parts: string[] = [];
  for (const failure of outcome.failedPeriods) {
    parts.push(`${failure.period} failed after ${failure.attempts} attempt(s): ${failure.message}`);
  }
  if (outcome.notReachedPeriods.length > 0) {
    parts.push(`${outcome.notReachedPeriods.join(", ")} not started — the run's time was spent`);
  }
  if (parts.length === 0) return "";
  return ` ${parts.join("; ")}. ${outcome.committedPeriods.length} other period(s) committed.`;
}

/**
 * Re-stamp the periods ONE AT A TIME, newest first, each in its own transaction.
 *
 * 🔴 ONE CALL FOR EVERY PERIOD LOST THE WHOLE NIGHT TO ONE SLOW MINUTE (4 Oct 2026). The nightly run
 * sent all open periods in one call; that night the database answered slowly, the gateway in front of
 * it cut the call at about two minutes ("upstream request timeout", 03:20:02 → 03:22:06 Cairo) and the
 * single transaction rolled every period back. The next night the same 2,375 rows re-stamped in 26 s.
 * Now a slow period costs only itself: it is tried once more when the failure was a cut and there is
 * time, and every other period still commits. Each period is still one transaction, so nothing is ever
 * half-written — and per period is exactly as safe as all at once, because every rollup refresh in
 * `phx_sync_sos_run` rebuilds a batch from that batch's own current rows.
 *
 * Newest first: when time runs out, it is the oldest open month that waits for the next night.
 */
export async function restampPeriodsOneByOne(input: {
  periods: readonly string[];
  restampPeriod: (period: string, timeoutMs: number) => Promise<{ restampedRows: number; refreshedBatches: number }>;
  remainingMs: () => number;
  /** Called once, after the FIRST period commits. */
  onFirstCommit?: () => Promise<void>;
}): Promise<TerritoryRestampOutcome> {
  const outcome: TerritoryRestampOutcome = {
    restampedRows: 0,
    refreshedBatches: 0,
    committedPeriods: [],
    failedPeriods: [],
    notReachedPeriods: [],
  };
  const newestFirst = [...input.periods].sort((a, b) => b.localeCompare(a));
  for (const period of newestFirst) {
    if (input.remainingMs() < MIN_START_MS) {
      outcome.notReachedPeriods.push(period);
      continue;
    }
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const done = await input.restampPeriod(period, Math.min(SYNC_REQUEST_TIMEOUT_MS, input.remainingMs()));
        outcome.restampedRows += done.restampedRows;
        outcome.refreshedBatches += done.refreshedBatches;
        outcome.committedPeriods.push(period);
        if (outcome.committedPeriods.length === 1 && input.onFirstCommit) await input.onFirstCommit();
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempts === 1 && territorySyncCallWasCut(message) && input.remainingMs() >= MIN_RETRY_MS) continue;
        outcome.failedPeriods.push({ period, message, attempts });
        break;
      }
    }
  }
  return outcome;
}

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
  /**
   * Called once the re-stamp transaction has COMMITTED, before the reconciliation read and the
   * audit write. Optional, and the human Sync button deliberately passes nothing — only the
   * scheduled run has a liveness register to answer to. See the call site for why it exists.
   */
  onWorkCommitted?: () => Promise<void> | void;
  /** How long the re-stamp may run before the rest wait for the next run (`TERRITORY_SYNC_*_BUDGET_MS`). */
  budgetMs?: number;
}): Promise<TerritorySyncReport> {
  const startedAt = Date.now();
  const periods = input.periods;
  const deadline = startedAt + (input.budgetMs ?? TERRITORY_SYNC_BUTTON_BUDGET_MS);

  // 1) Re-stamp + rebuild the affected batches' rollups atomically, server-side, ONE PERIOD PER CALL
  //    (`restampPeriodsOneByOne`). Each call is one transaction, so an abort cannot leave a
  //    half-applied state, and a slow period no longer rolls back every other one.
  const restampPeriod = async (period: string, timeoutMs: number) => {
    const runClient = getSupabaseAdmin({ requestTimeoutMs: timeoutMs });
    const { data: runData, error: runError } = await runClient.rpc("phx_sync_sos_run", {
      p_periods: [period],
    });
    if (runError) throw new Error(runError.message);
    const runRow = (Array.isArray(runData) ? runData[0] : runData) as
      | { restamped_rows?: number; refreshed_batches?: number }
      | null
      | undefined;
    return { restampedRows: toNumber(runRow?.restamped_rows), refreshedBatches: toNumber(runRow?.refreshed_batches) };
  };

  // THE DURABLE WORK IS COMMITTED the moment the first period returns. Everything after the loop —
  // the reconciliation read, the cache invalidation, the audit row — is reporting ABOUT work that has
  // already landed.
  //
  // On 2026-09-04 that distinction cost this job its heartbeat. The nightly re-stamp committed at
  // 03:20:00 Cairo (7 periods' attribution rollups carry that exact `refreshed_at`), and the
  // production deploy of #3035 went live 31 seconds later and replaced the container. Nothing
  // below ever ran: no audit row, no ping. The register then reported "stranded — nothing has
  // reported" every 15 minutes for 14 hours, about a run that had done its job correctly.
  //
  // The tail is not fast enough to be safe on its own — the run measured 24.3s on 2026-09-03
  // against cron-job.org's hard 30s cap — and production deploys land on every merge. So the
  // caller reports success at that first commit, the earliest instant the claim is true, instead of
  // after a tail any routine deploy can cut.
  //
  // AWAITED, not fire-and-forget: an unawaited promise is exactly as orphanable as the tail it
  // replaces. Wrapped, because a reporting failure must never turn a committed sync into a failed
  // one — `pingDeadMansSwitch` already swallows its own errors, and this is the belt to that brace.
  const reportCommitted = async () => {
    if (input.onWorkCommitted) {
      try {
        await input.onWorkCommitted();
      } catch {
        // Intentionally silent: this catch exists so the sync's own result survives a broken
        // reporter, and logging from here could fail for the very reason the callback did.
      }
    }
  };
  const restamp = await restampPeriodsOneByOne({
    onFirstCommit: reportCommitted,
    periods,
    remainingMs: () => deadline - Date.now(),
    restampPeriod,
  });
  const { restampedRows, refreshedBatches } = restamp;
  if (restamp.committedPeriods.length === 0 && restamp.failedPeriods.length > 0) {
    // Nothing landed: say so exactly as before, with the database's own words.
    throw new Error(`Territory sync failed: ${restamp.failedPeriods[0].message}`);
  }

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
      failed_periods: restamp.failedPeriods,
      not_reached_periods: restamp.notReachedPeriods,
      synced_at: syncedAt,
    },
    summary:
      `Territory sync: re-stamped ${restampedRows} row(s), rebuilt ${refreshedBatches} batch(es), ` +
      `reconciled=${allReconciled}` +
      (geographyChecked
        ? `, geography off on ${geoMismatchRows} row(s), ${unrollupRows} row(s) with no rollup row.`
        : " — geography NOT checked (database still on the quantity-only reconciliation function).") +
      unfinishedSummary(restamp),
  });

  // Some periods committed and some did not: the audit row above says which, and the run still FAILS,
  // so the job register and the Sync button never call a partial night a clean one.
  if (restamp.failedPeriods.length > 0 || restamp.notReachedPeriods.length > 0) {
    throw new Error(`Territory sync failed:${unfinishedSummary(restamp)}`);
  }

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
 * Resolve an audit actor's login id to a human name for display (owner rule: names, never codes
 * or IDs, in chat or UI) — never the raw `actor_login_id` itself. The nightly job's own actor
 * (scheduled-sync.ts's `SCHEDULED_TERRITORY_SYNC_ACTOR`) is a "system:"-prefixed login with no
 * employee behind it at all, so that case is named explicitly rather than looked up.
 */
async function resolveSyncActorDisplayName(loginId: string | null): Promise<string | null> {
  if (!loginId) return null;
  if (loginId.startsWith("system:")) return "the automated nightly sync";

  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("app_auth_users").select("name,hr_id").eq("login_id", loginId).maybeSingle();
  const row = data as { name?: string | null; hr_id?: string | null } | null;
  if (row?.name) return row.name;

  const hrId = row?.hr_id ?? null;
  if (hrId) {
    const directory = await getEmployeeDirectory().catch(() => null);
    const employee = directory?.employees.find((e) => e.hrId.trim().toLowerCase() === hrId.trim().toLowerCase());
    if (employee?.displayName) return employee.displayName;
  }

  // A real account ran this, we just cannot name it — never fall through to the raw login/HR id.
  return "a colleague";
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
    lastSyncedBy: await resolveSyncActorDisplayName(row.actor_login_id ?? null),
    lastRestampedRows: typeof restamped === "number" ? restamped : null,
    lastAllReconciled: typeof reconciled === "boolean" ? reconciled : null,
  };
}
