import { NextResponse } from "next/server";

import { isProductionRuntime } from "@/config/system-settings";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logCronUnauthorized, logError } from "@/lib/observability/log";
import { captureQueryStatsSnapshot } from "@/lib/observability/query-stats-snapshot";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { bearerSecretMatches } from "@/lib/security/constant-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Healthchecks slug, `phoenix-<route>` like every other watched cron route. */
const JOB_SLUG = "phoenix-db-health-snapshot";

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !isProductionRuntime();
  return bearerSecretMatches(request.headers.get("authorization"), secret);
}

/**
 * Snapshots pg_stat_statements so slow-query history is retained and queryable.
 *
 * Read `public.v_slow_query_deltas` afterwards to see what did the most work between the
 * two most recent captures — that is the view that would have surfaced the 17.5s monthly
 * closing call the 2026-08-10 audit found by hand.
 *
 * Scheduled on cron-job.org as job 8242721, every 6 hours at :17 Africa/Cairo, alongside the
 * outbox drain and iReports sync; the GCP Cloud Scheduler jobs 401 on every route and are not
 * the production scheduler.
 *
 * WHY THIS PINGS AT ALL, HAVING ONCE DECIDED NOT TO.
 * This route used to say it was deliberately unwatched: a missed snapshot is a gap in a graph,
 * not an incident, and paging on it would train the owner to ignore the pager. That reasoning
 * was sound about SEVERITY and wrong about VISIBILITY. Unwatched did not mean "alerts quietly";
 * it meant nothing anywhere would ever say this job had stopped. On 2026-08-24 a half-finished
 * CRON_SECRET rotation left six of twelve cron-job.org jobs presenting a superseded token, and
 * every one of them 401'd here — before any ping, so they went silent rather than red. The only
 * reason that was caught at all is that the hourly synthetic-journeys check blew its grace
 * window; this job, on a 6-hourly clock and with no check at all, would have stayed dark
 * indefinitely and taken the slow-query history with it.
 *
 * The severity argument is answered by the GRACE, not by the silence: docs/observability.md
 * gives this check a 2h grace against its every-6-hours-at-:17 Cairo clock, so a single slow
 * run or a deploy restart never pages, and only a genuinely missed snapshot does.
 *
 * Pinged directly rather than via withDeadMansSwitch because this route CATCHES its own error
 * and answers 500 instead of throwing — the wrapper sees no throw and would report a failed
 * snapshot as a success, which is the precise failure this is meant to detect.
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("cron/db-health-snapshot", request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await captureQueryStatsSnapshot();
    await pingDeadMansSwitch(JOB_SLUG, "success");
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("pg_stat_statements snapshot failed — slow-query history has a gap", {
      labels: { event: "cron_failed", job: "db-health-snapshot" },
      error,
    });
    await pingDeadMansSwitch(
      JOB_SLUG,
      "fail",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
    const message = clientSafeErrorMessage(error, "Query stats snapshot failed.");
    return NextResponse.json(
      { error: "db_health_snapshot_failed", message },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
