import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { runProductionPlanningFxFetch } from "@/lib/production-planning/fx-sweep";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One dollar rate a day, so a price typed in dollars keeps deriving a pound figure that is current.
 *
 * It never overwrites a good rate with nothing — a failed read records `fetch_ok = false` and the
 * reason against today's date and leaves the last good rate standing — and it never touches a rate
 * the owner typed by hand, which is a separate column that wins at read time.
 *
 * Its own pair of switches, independent of the reorder email's: `fx_fetch_enabled` and
 * `fx_fetch_dry_run`, both read fail-safe. A dry run reports the rate it would have stored.
 *
 * 06:05 Cairo, five minutes ahead of the reorder sweep so a cost the email might carry is read off
 * today's rate rather than yesterday's, and on a minute nothing else in the account uses.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/production-planning-fx");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-production-planning-fx", () => runProductionPlanningFxFetch());
    return NextResponse.json({
      success: true,
      dryRun: result.dryRun,
      error: result.error,
      fetched: result.fetched,
      rateDate: result.rateDate,
      skipped: result.skipped,
      stored: result.stored,
    });
  } catch (error) {
    logError("Production planner FX fetch failed", {
      labels: { event: "cron_failed", job: "production-planning-fx" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Production planner FX fetch failed.");
    return NextResponse.json({ error: "production_planning_fx_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
