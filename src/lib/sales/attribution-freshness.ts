import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Keep the precomputed attribution rollup usable after a mapping change.
 *
 * `au.f_monthly_achievement` serves the stored rollup only while the configuration fingerprint that
 * was saved beside it still matches. That fingerprint covers the config surface — the customer map,
 * the bricks, the areas — so any ordinary re-mapping drifts it, and every achievement read then
 * recomputes from the fact rollup instead.
 *
 * THE SYMPTOM IS SLOWNESS, NEVER A WRONG NUMBER, which is exactly why nobody noticed. On 2026-09-11
 * all nine periods of 2026 had drifted and every screen was recomputing, with no error, no badge and
 * nothing in the logs. Until this existed the only cure was the 03:20 nightly re-stamp, so a mapping
 * change made during the working day left the rollup unusable until the following morning.
 */

/**
 * Periods refreshed per run. The caller is the ten-minute mapping-guard clock, which sits in front of
 * cron-job.org's unraisable 30-second cut, so a run stays short and a backlog drains over the next few
 * runs rather than becoming one long transaction.
 */
export const ATTRIBUTION_FRESHNESS_PERIODS_PER_RUN = 6;

/**
 * Longer than the 15s default because a run may refresh several periods. It matters less than it
 * looks: the sweep is one server-side function, therefore one transaction, so a client abort rolls
 * the whole thing back rather than leaving half the periods refreshed — and the next run simply finds
 * the same candidates again. Re-running it is always safe.
 */
const SWEEP_REQUEST_TIMEOUT_MS = 60_000;

export type AttributionFreshnessResult = {
  /** Period keys actually refreshed, newest first. Empty is the healthy steady state. */
  refreshed: string[];
  /** True when the sweep could not run. The caller continues regardless — see below. */
  failed: boolean;
  /** Why it could not run, for the caller's response body. Null on success. */
  reason: string | null;
};

/**
 * Refresh every period the gate can no longer use, newest first.
 *
 * NEVER THROWS, deliberately. Its caller is the mapping-guard alert route, whose job is to tell the
 * owner that mapping changes are being refused. A rollup that could not be refreshed is a performance
 * problem; an alert that did not go out is the map silently swallowing writes. The second must not be
 * able to fail because of the first, so this reports its own failure and returns.
 */
export async function refreshStaleAttributionPeriods(options?: {
  limit?: number;
}): Promise<AttributionFreshnessResult> {
  const limit = Math.min(Math.max(options?.limit ?? ATTRIBUTION_FRESHNESS_PERIODS_PER_RUN, 1), 24);
  try {
    const supabase = getSupabaseAdmin({ requestTimeoutMs: SWEEP_REQUEST_TIMEOUT_MS });
    const { data, error } = await supabase.rpc("phx_refresh_stale_attribution_periods", {
      p_limit: limit,
    });
    if (error) throw new Error(error.message);
    // The function returns a set of period keys; PostgREST hands back scalars as bare values.
    const refreshed = (Array.isArray(data) ? data : [])
      .map((row) =>
        typeof row === "string"
          ? row
          : String((row as { phx_refresh_stale_attribution_periods?: unknown })?.phx_refresh_stale_attribution_periods ?? ""),
      )
      .filter((period) => period.length > 0);
    return { failed: false, reason: null, refreshed };
  } catch (error) {
    logError("Attribution freshness sweep failed", {
      labels: { event: "attribution_freshness_failed", job: "mapping-guard-notify" },
      error,
    });
    return {
      failed: true,
      reason: error instanceof Error ? error.message : "The attribution freshness sweep failed.",
      refreshed: [],
    };
  }
}
