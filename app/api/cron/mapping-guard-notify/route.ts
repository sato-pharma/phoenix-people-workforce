import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { refreshStaleAttributionPeriods } from "@/lib/sales/attribution-freshness";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The attribution freshness clock.
 *
 * This route used to be the Mapping Guard's alert, which told the owner which re-mappings the
 * database guard had stopped. The owner retired the guard on 2026-10-10 and the alert went with it.
 * THE PATH AND THE JOB NAME STAY, because the clock that calls this URL lives on cron-job.org and
 * the dead man's switch is registered under this slug; renaming either would silently stop the sweep.
 *
 * A mapping change drifts the configuration fingerprint that lets `au.f_monthly_achievement` serve its
 * precomputed rollup, after which every achievement read recomputes from the fact rollup — no error,
 * no wrong number, just a system quietly doing the work again on every request. Sweeping here every
 * few minutes means a change heals within minutes whatever made it, including hand SQL, which no
 * amount of wiring inside the application's own write paths could cover.
 *
 * The sweep reports its own failure and never throws, so a rollup that could not be refreshed shows
 * in the response and the logs instead of turning the clock's run into a 500.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/mapping-guard-notify");
  if (denied) return denied;
  try {
    const freshness = await withDeadMansSwitch("phoenix-mapping-guard-notify", () => refreshStaleAttributionPeriods());

    return NextResponse.json({
      success: true,
      attributionPeriodsRefreshed: freshness.refreshed,
      attributionSweepFailed: freshness.failed,
      warnings: freshness.reason ? [freshness.reason] : [],
    });
  } catch (error) {
    logError("Attribution freshness clock failed", {
      labels: { event: "cron_failed", job: "mapping-guard-notify" },
      error,
    });
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Attribution freshness clock failed.") },
      { status: 500 },
    );
  }
}
