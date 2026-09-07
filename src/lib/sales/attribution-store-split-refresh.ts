// Rebuild the wholesaler city split net for every period a batch touched.
//
// ORDER IS THE WHOLE POINT. au.f_monthly_attribution reads au.monthly_store_split_net, so the net
// has to be current BEFORE phx_refresh_monthly_attribution materialises the period. Refreshing first
// would bake the previous split into the rollup and leave it there until the next import — a wrong
// achievement number with nothing reporting it. Every call site therefore calls this immediately
// before its attribution refresh, and tests/attribution-store-split-net.test.ts pins that ordering
// file by file.
//
// 🔴 WHY THIS IS NOT A WRAPPER AROUND THE REFRESH RPC, which is the obvious shape and was written
// first. tests/sos-import-summaries-refresh.test.ts uses the literal string
// `phx_refresh_monthly_attribution` as its MARKER for "this file is a rollup-refresh site", and then
// insists every such file also refreshes the import summaries. Folding the RPC into a helper removed
// that marker from all four sites at once: the guard went from four sites to one and went red — it
// caught exactly the erosion it exists to catch. The marker stays where the guard can see it, and
// this module does the one thing the guard knows nothing about.
//
// EVERY PERIOD THE BATCH TOUCHED, not just one. A multi-period import writes fact rows for several
// months and phx_refresh_monthly_attribution rebuilds all of them, so the net has to cover the same
// set or the months it missed would be refreshed against a stale net.

import { systemAccessContext } from "@/lib/auth/permissions";
import { loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import {
  writeAttributionStoreSplitNet,
  type AttributionSplitRow,
  type AttributionStoreSplitWriteResult,
} from "@/lib/sales/attribution-store-split-net";

/**
 * `from` returns `unknown` on purpose, and the shape it really has is applied by the cast in
 * periodsOfBatch below.
 *
 * Spelling the query-builder chain out here instead made tsc fail with TS2589 "type instantiation is
 * excessively deep and possibly infinite" at the call site in monthly-distributor-import.ts — the
 * real client's `from` is generic over the whole generated Database type, and checking the live
 * client against a hand-written structural chain forces TypeScript to expand all of it. `unknown`
 * accepts any `from` without expanding anything. `rpc` is safe to spell out because its return type
 * is shallow.
 */
type SupabaseLike = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
  from: (table: string) => unknown;
};

/** The slice of the query builder periodsOfBatch actually uses. */
type PeriodQuery = {
  select: (columns: string) => {
    eq: (column: string, value: unknown) => PromiseLike<{ data: unknown; error: unknown }>;
  };
};

/**
 * The closing's own detail rows for one line and period.
 *
 * `includeConfidential: false` matches loadClosingStoreSplitUncached, and it also matches
 * au.f_monthly_attribution: the restricted set is exactly LA003 / LA004 / SS001, which the SQL
 * excludes by name. The two populations are therefore identical, so the net can neither miss a
 * product attribution counts nor carry one it does not.
 */
async function loadRowsForLine(line: string, period: string): Promise<readonly AttributionSplitRow[]> {
  const details = await loadMonthlyClosingDetails({
    access: systemAccessContext,
    line,
    period,
    availableLines: [line],
    availablePeriods: [period],
    includeConfidential: false,
    unpaged: true,
  });
  return details.rows;
}

/** Distinct periods this batch put fact rows into — the exact set attribution will rebuild. */
async function periodsOfBatch(supabase: SupabaseLike, batchId: string): Promise<string[]> {
  const { data, error } = await (supabase.from("source_of_sales_fact_rollup") as PeriodQuery)
    .select("period")
    .eq("batch_id", batchId);
  if (error) throw error;
  const periods = new Set<string>();
  for (const row of (Array.isArray(data) ? data : []) as { period?: unknown }[]) {
    const period = String(row?.period ?? "").trim();
    if (/^\d{4}-\d{2}$/.test(period)) periods.add(period);
  }
  return [...periods].sort();
}

/**
 * Recompute and store the split net for every period this batch touched.
 *
 * Call it IMMEDIATELY BEFORE phx_refresh_monthly_attribution, never after. Throws on failure — a net
 * that silently failed to write leaves attribution applying yesterday's split, which is a wrong
 * number on everyone's Sales vs Target with no error anywhere.
 */
export async function writeStoreSplitNetForBatch(
  supabase: SupabaseLike,
  batchId: string,
): Promise<{ periods: string[]; splits: AttributionStoreSplitWriteResult[] }> {
  const periods = await periodsOfBatch(supabase, batchId);
  const splits: AttributionStoreSplitWriteResult[] = [];
  for (const period of periods) {
    splits.push(await writeAttributionStoreSplitNet({ period, supabase, loadRowsForLine }));
  }
  return { periods, splits };
}
