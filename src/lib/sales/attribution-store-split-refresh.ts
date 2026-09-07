// The one entry point every import path uses to rebuild attribution.
//
// ORDER IS THE WHOLE POINT. au.f_monthly_attribution reads au.monthly_store_split_net, so the net
// has to be current BEFORE phx_refresh_monthly_attribution materialises the period. Calling them the
// other way round would bake the previous split into the rollup and leave it there until the next
// import — a wrong achievement number with nothing reporting it. Wrapping both in one function is
// what stops a future call site from getting that order wrong: there is no longer a bare
// phx_refresh_monthly_attribution to copy.
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

type SupabaseLike = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
};

/**
 * The closing's own detail rows for one line and period.
 *
 * `includeConfidential: false` matches loadClosingStoreSplitUncached, and it also matches
 * au.f_monthly_attribution: the restricted set is exactly LA003 / LA004 / SS001, which the SQL
 * excludes by name. So the two populations are the same three codes apart from everything, and the
 * net can neither miss a product attribution counts nor carry one it does not.
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
  const { data, error } = await supabase
    .from("source_of_sales_fact_rollup")
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
 * Recompute the wholesaler split net for every period this batch touched, then rebuild the
 * attribution rollup. Throws on any failure — a half-refreshed attribution is a wrong number on
 * Sales vs Target, so it must not be swallowed.
 */
export async function refreshAttributionWithStoreSplit(
  supabase: SupabaseLike,
  batchId: string,
): Promise<{ periods: string[]; splits: AttributionStoreSplitWriteResult[] }> {
  const periods = await periodsOfBatch(supabase, batchId);
  const splits: AttributionStoreSplitWriteResult[] = [];

  for (const period of periods) {
    splits.push(await writeAttributionStoreSplitNet({ period, supabase, loadRowsForLine }));
  }

  const refresh = await supabase.rpc("phx_refresh_monthly_attribution", { p_batch_id: batchId });
  if (refresh.error) throw refresh.error;

  return { periods, splits };
}
