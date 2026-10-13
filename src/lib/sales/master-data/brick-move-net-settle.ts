import { writeStoreSplitNetForPeriods } from "@/lib/sales/attribution-store-split-refresh";
import { isStoreCitySplitActive } from "@/lib/sales/store-sales-city-split";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Make a brick move land on the NUMBERS, not just on the files.
 *
 * WHAT THIS IS FOR, and what it is NOT. `refreshBatchRollups` already rebuilds the store-split net
 * per batch, and `writeStoreSplitNetForBatch` is period-grain inside — so a drain that completes
 * every file through the app converges on its own. This exists for the case that does not: a file
 * finished any OTHER way. One file of the مدينة قنا move of 2026-10-13 exceeded the 8-second
 * statement timeout and had to be completed over a direct SQL connection, where the net step —
 * TypeScript, computed from the closing's own detail rows — cannot run at all. The queue reached
 * zero, every file read as rebuilt, and the stored net for 2026-08 and 2026-09 was still the
 * pre-move one: 2 cells in August and 62 in September, 74,741.23 EGP sitting on the wrong area with
 * every Sales-vs-Target screen reading it and nothing anywhere saying so.
 *
 * WHY IT RUNS ONLY AFTER REAL WORK, and is not a standing sweep. `phx_brick_move_period_net_status`
 * answers "was this period's net computed before the last brick move that touched it?", which is a
 * SUSPICION and not drift: July 2026's net predates the قنا move and is nevertheless correct to the
 * cell, because nothing in July moved between those two areas. Recomputing is idempotent — the net
 * is a pure function of the closing detail rows — so a needless pass is harmless but not free, and a
 * standing sweep would pay it on a schedule for ever. Worse, two kinds of period can never satisfy
 * such a sweep at all: a PUBLISHED period, which `phx_write_monthly_store_split_net` refuses by
 * design, and a period whose net legitimately computes to empty. Either would be retried on every
 * fire, for ever. So this runs when the drain actually rebuilt something, and the residue is
 * REPORTED rather than retried.
 *
 * A PUBLISHED PERIOD IS NEVER TOUCHED. The database refuses it anyway — the freeze of
 * 20260927213000 — but it is skipped here by name, with the period reported: re-stamping a published
 * month would move numbers under a closing that has already gone out, which is the owner's decision
 * and never a side effect of a brick move.
 *
 * WHY THE CLIENT AND THE NET WRITER ARE BOTH INJECTABLE. The same reason `loadRowsForLine` is in
 * `attribution-store-split-net.ts`: without it, a unit test of this rule reaches into the live
 * database — and this repo's suite runs with PRODUCTION credentials, so the test would recompute and
 * REWRITE a real period's net. The structural client type is also what keeps tsc off the generated
 * Database type, which TS2589'd at a call site when it was spelled out.
 */

/** At most this many periods per fire, so one move can never become a four-minute recompute. */
export const SETTLE_PERIODS_PER_RUN = 3;

/** How far back the status read looks. A move settles within hours; three days is already generous. */
export const SETTLE_STATUS_WINDOW_DAYS = 3;

/** The slice of the Supabase client this module uses. See the header on why it is structural. */
export type SettleSupabase = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
  from: (table: string) => unknown;
};

/** The chain periodsOfBatches needs. */
type BatchPeriodQuery = {
  select: (columns: string) => {
    eq: (column: string, value: unknown) => PromiseLike<{ data: unknown; error: unknown }>;
  };
};

/** The chain publishedPeriods needs. */
type PublicationQuery = {
  select: (columns: string) => {
    in: (column: string, values: unknown[]) => {
      is: (column: string, value: unknown) => PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
};

type PeriodNetStatus = {
  period: string;
  lastMovedAt: string;
  netComputedAt: string | null;
};

export type BrickMoveNetSettleResult = {
  /** Periods the rebuilt files touched, before any filtering. */
  touched: string[];
  /** Periods whose net was rebuilt and attribution re-stamped. */
  settled: string[];
  /** Periods left alone because the month is published — reported, never written. */
  skippedPublished: string[];
  /** Periods already current: their net was computed after the last move that touched them. */
  alreadyCurrent: string[];
  /** Periods the city split does not reach at all, so their net is empty by design. */
  outsideSplit: string[];
  /** Candidates not settled this fire — the per-run cap, or everything after a failure. */
  deferred: string[];
  /** Why a period could not be settled. Null when every candidate landed. */
  failure: string | null;
};

const EMPTY: BrickMoveNetSettleResult = {
  alreadyCurrent: [],
  deferred: [],
  failure: null,
  outsideSplit: [],
  settled: [],
  skippedPublished: [],
  touched: [],
};

/** Distinct periods these batches put fact rows into — the exact set a rebuild has to cover. */
async function periodsOfBatches(supabase: SettleSupabase, batchIds: readonly string[]): Promise<string[]> {
  const periods = new Set<string>();
  for (const batchId of batchIds) {
    const { data, error } = await (supabase.from("source_of_sales_fact_rollup") as BatchPeriodQuery)
      .select("period")
      .eq("batch_id", batchId);
    if (error) throw error;
    for (const row of (Array.isArray(data) ? data : []) as { period?: unknown }[]) {
      const period = String(row?.period ?? "").trim();
      if (/^\d{4}-\d{2}$/.test(period)) periods.add(period);
    }
  }
  return [...periods].sort();
}

async function readNetStatus(supabase: SettleSupabase): Promise<Map<string, PeriodNetStatus>> {
  const { data, error } = await supabase.rpc("phx_brick_move_period_net_status", {
    p_since_days: SETTLE_STATUS_WINDOW_DAYS,
  });
  if (error) throw error;
  const byPeriod = new Map<string, PeriodNetStatus>();
  for (const row of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
    const period = String(row?.period ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(period)) continue;
    byPeriod.set(period, {
      lastMovedAt: String(row?.last_moved_at ?? ""),
      netComputedAt: row?.net_computed_at ? String(row.net_computed_at) : null,
      period,
    });
  }
  return byPeriod;
}

/** Periods holding a LIVE publication row. An unpublished row does not count. */
async function publishedPeriods(supabase: SettleSupabase, periods: readonly string[]): Promise<Set<string>> {
  if (periods.length === 0) return new Set();
  const { data, error } = await (supabase.from("monthly_closing_publications") as PublicationQuery)
    .select("period")
    .in("period", [...periods])
    .is("unpublished_at", null);
  if (error) throw error;
  const published = new Set<string>();
  for (const row of (Array.isArray(data) ? data : []) as { period?: unknown }[]) {
    const period = String(row?.period ?? "").trim();
    if (period.length > 0) published.add(period);
  }
  return published;
}

/**
 * The net predates the move that touched the period, so the stored split is the pre-move one.
 *
 * A period with no status row is treated as CURRENT: the status read only looks back three days, so
 * its absence means the move is older than that window, not that it was never settled. An
 * unparseable timestamp is also treated as current — this must never recompute a real period's net
 * because a date could not be read.
 */
export function netPredatesMove(status: PeriodNetStatus | undefined): boolean {
  if (!status) return false;
  if (!status.netComputedAt) return true;
  const net = new Date(status.netComputedAt).getTime();
  const moved = new Date(status.lastMovedAt).getTime();
  if (!Number.isFinite(net) || !Number.isFinite(moved)) return false;
  return net < moved;
}

/**
 * Rebuild the split net, and re-stamp attribution, for every period the given batches touched whose
 * net still predates the move.
 *
 * Throws only if it could not assess at all. A per-period failure stops the loop and comes back in
 * `failure`, with everything that did land in `settled` and the rest in `deferred`, so the caller
 * can report exactly what moved.
 */
export async function settleBrickMoveNet(input: {
  batchIds: readonly string[];
  supabase?: SettleSupabase;
  /** Injectable for the reason in the header: the default reaches the live closing detail rows. */
  writeNetForPeriods?: (supabase: SettleSupabase, periods: readonly string[]) => Promise<unknown>;
}): Promise<BrickMoveNetSettleResult> {
  const batchIds = [...new Set(input.batchIds.filter((id) => String(id ?? "").trim().length > 0))];
  if (batchIds.length === 0) return EMPTY;

  const supabase = input.supabase ?? (getSupabaseAdmin() as unknown as SettleSupabase);
  const writeNet =
    input.writeNetForPeriods ??
    ((client: SettleSupabase, periods: readonly string[]) => writeStoreSplitNetForPeriods(client, periods));

  const touched = await periodsOfBatches(supabase, batchIds);
  if (touched.length === 0) return { ...EMPTY, touched };

  const outsideSplit = touched.filter((period) => !isStoreCitySplitActive(period));
  const inSplit = touched.filter((period) => isStoreCitySplitActive(period));

  const status = await readNetStatus(supabase);
  const stale = inSplit.filter((period) => netPredatesMove(status.get(period)));
  const alreadyCurrent = inSplit.filter((period) => !netPredatesMove(status.get(period)));

  const published = await publishedPeriods(supabase, stale);
  const skippedPublished = stale.filter((period) => published.has(period));
  const writable = stale.filter((period) => !published.has(period));

  const take = writable.slice(0, SETTLE_PERIODS_PER_RUN);
  const capped = writable.slice(SETTLE_PERIODS_PER_RUN);

  const settled: string[] = [];
  let failure: string | null = null;
  for (const period of take) {
    try {
      // The net FIRST — au.f_monthly_attribution reads it, so re-stamping before the write would
      // bake the pre-move split into the rollup and leave it there until something else moved.
      await writeNet(supabase, [period]);
      const refreshed = await supabase.rpc("phx_refresh_attribution_for_period", { p_period: period });
      if (refreshed.error) {
        const message = (refreshed.error as { message?: unknown })?.message;
        throw new Error(String(message ?? "the attribution re-stamp failed"));
      }
      settled.push(period);
    } catch (error) {
      failure = error instanceof Error ? error.message : "unknown error";
      break;
    }
  }

  return {
    alreadyCurrent,
    deferred: [...capped, ...take.filter((period) => !settled.includes(period))].sort(),
    failure,
    outsideSplit,
    settled,
    skippedPublished,
    touched,
  };
}
