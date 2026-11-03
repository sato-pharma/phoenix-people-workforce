// Writes the ended hours' page timings to the page_timings table: one RPC an hour per web process,
// called from the process-health tick (process-health.ts). Rows are forgotten once the database
// has taken them — a refused write is logged and tried again on the next tick, and page-timing-store.ts
// drops anything older than two days, so a long refusal never becomes a leak.
//
// A TIMEOUT IS NOT A REFUSAL (3 Nov 2026). The client gives up after 15 s, but the function it called
// can still commit, and phx_page_timings_record ADDS to an hour's row on conflict, so sending the same
// rows again doubled that hour's counts. A timed-out write is forgotten instead: an hour may go
// missing from the Slowest pages tab, but it is never counted twice.
//
// The table holds a page shape, an hour, a kind, a device class and milliseconds — no person, no
// address, no user agent (page-timing-intake.ts decides what can get this far). Pruned at 30 days by
// phx_prune_retention (owner, 1 Nov 2026: "hourly medians per page, 30 days, no names").

import type { SupabaseClient } from "@supabase/supabase-js";

import { logWarning } from "@/lib/observability/log";
import { forgetPageTimingHours, pageTimingRowsBefore } from "@/lib/observability/page-timing-store";
import { isSupabaseTimeout } from "@/lib/supabase/errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const PAGE_TIMINGS_RECORD_RPC = "phx_page_timings_record";

export type PageTimingsRpcClient = Pick<SupabaseClient, "rpc">;

/** Rows written; 0 when no hour had ended or the database refused them. */
export async function flushPageTimings(input: { client?: PageTimingsRpcClient; now?: Date } = {}): Promise<number> {
  const rows = pageTimingRowsBefore(input.now ?? new Date());
  if (rows.length === 0) return 0;
  const client = input.client ?? getSupabaseAdmin({ requestTimeoutMs: 15_000 });
  const { error } = await client.rpc(PAGE_TIMINGS_RECORD_RPC, { p_rows: rows });
  // The client hands a timeout back as a plain object, so the words are read from its message.
  if (error && isSupabaseTimeout(error.message)) {
    forgetPageTimingHours(new Set(rows.map((row) => row.hour)));
    logWarning("page timings flush timed out, and its hours are not sent again", {
      labels: { event: "page_timings_flush_timed_out" },
      context: { rows: rows.length },
    });
    return 0;
  }
  if (error) {
    logWarning("page timings flush refused", {
      labels: { event: "page_timings_flush_failed" },
      context: { message: error.message, rows: rows.length },
    });
    return 0;
  }
  forgetPageTimingHours(new Set(rows.map((row) => row.hour)));
  return rows.length;
}
