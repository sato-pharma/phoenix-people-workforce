import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Captures a point-in-time snapshot of pg_stat_statements into
 * `public.pg_stat_statements_snapshots`, so slow-query history is queryable from the app
 * instead of living only in platform logs.
 *
 * This exists because neither `log_min_duration_statement` nor `track_io_timing` can be
 * turned on here: Supabase's config API rejects both keys outright, and `ALTER DATABASE`
 * refuses them because both are superuser-context GUCs. The 2026-08-10 health audit found
 * a query taking 17.5 seconds that had run 192 times with nothing anywhere reporting it.
 *
 * The snapshot deliberately ranks on three axes (cumulative, max, mean). Ranking on
 * cumulative time alone — the obvious implementation — cannot see the query that matters:
 * something slow per call has a small cumulative total until it has already done real
 * damage, so it never enters a top-N list headed by high-traffic PostgREST queries.
 */
export type QueryStatsSnapshotResult = {
  captured: number;
};

export async function captureQueryStatsSnapshot(
  topN = 50,
): Promise<QueryStatsSnapshotResult> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.rpc("phx_capture_query_stats", {
    p_top: topN,
  });

  if (error) {
    throw new Error(`pg_stat_statements snapshot failed: ${error.message}`);
  }

  return { captured: typeof data === "number" ? data : 0 };
}
