// Rebuild everything the Source of Sales derives from one batch's import rows.
//
// WHY IT EXISTS. scripts/restore-source-of-sales.mjs writes the import rows back and nothing that
// is computed from them: the fact rollup and the customer presence rollup it fills, the customer
// directory, the channel and distributor x product rollups, marketing ROI, the wholesaler city split
// net, monthly attribution and the import summaries. Until 2026-09-18 a restore stopped there, so
// the dashboards and the Monthly Closing read rollups that no longer matched the rows (SoS
// re-measure 2026-09-18, #23). The restore now runs this for every validated batch.
//
// THE SAME CHAIN, IN THE SAME ORDER, AS AN IMPORT'S. Each step reads what the one before it wrote:
//   1. fact rollup (it also rebuilds the customer presence rollup), customer directory, marketing ROI
//   2. channel rollup: reads the fact and directory rollups
//   3. distributor x product rollup: reads the fact rollup
//   4. the city split net: reads the fact rollup, and attribution reads the net
//   5. monthly attribution
//   6. import summaries: what the Source of Sales dashboard renders
// Every refresh deletes the batch's rows before it writes them, so running this twice gives the
// same result.
//
// UNLIKE the correction paths in normalizer/mapping.ts and normalizer/customer-map.ts, a failed step
// throws. Those paths keep a mapping that already saved and let a later reconcile retry; a restore
// has nothing to fall back on, and a rollup that silently failed would leave a screen wrong with no
// error anywhere.

import { writeStoreSplitNetForBatch } from "@/lib/sales/attribution-store-split-refresh";

type SupabaseLike = Parameters<typeof writeStoreSplitNetForBatch>[0];

function orThrow(step: string, batchId: string, result: { error: unknown }): void {
  if (!result.error) return;
  const error = result.error as { message?: unknown };
  const detail = typeof error?.message === "string" ? error.message : String(result.error);
  throw new Error(`${step} failed for batch ${batchId}: ${detail}`);
}

/** Rebuild every rollup, the split net, attribution and the summaries for one batch. Throws on the first failure. */
export async function rebuildSourceOfSalesRollupsForBatch(supabase: SupabaseLike, batchId: string): Promise<void> {
  orThrow("The fact rollup", batchId, await supabase.rpc("phx_refresh_sos_fact_rollup", { p_batch_id: batchId }));
  orThrow("The customer directory rollup", batchId, await supabase.rpc("phx_refresh_sos_customer_directory_rollup", { p_batch_id: batchId }));
  orThrow("The marketing ROI facts", batchId, await supabase.rpc("phx_refresh_marketing_roi_facts", { p_batch_id: batchId }));
  orThrow("The channel rollup", batchId, await supabase.rpc("phx_refresh_sos_channel_rollup", { p_batch_id: batchId }));
  orThrow("The distributor x product rollup", batchId, await supabase.rpc("phx_refresh_sos_distributor_product_rollup", { p_batch_id: batchId }));
  // The split net FIRST: au.f_monthly_attribution reads it.
  await writeStoreSplitNetForBatch(supabase, batchId);
  orThrow("Monthly attribution", batchId, await supabase.rpc("phx_refresh_monthly_attribution", { p_batch_id: batchId }));
  orThrow("The import summaries", batchId, await supabase.rpc("phx_refresh_sos_import_summaries", { p_batch_id: batchId }));
}
