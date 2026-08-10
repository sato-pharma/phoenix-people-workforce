import { NextResponse } from "next/server";

import { isProductionRuntime } from "@/config/system-settings";
import { logCronUnauthorized, logError } from "@/lib/observability/log";
import { captureQueryStatsSnapshot } from "@/lib/observability/query-stats-snapshot";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { bearerSecretMatches } from "@/lib/security/constant-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
 * Schedule this on cron-job.org alongside the outbox drain and iReports sync; the GCP
 * Cloud Scheduler jobs 401 on every route and are not the production scheduler.
 *
 * Deliberately NOT wrapped in withDeadMansSwitch: a missed monitoring snapshot is a gap
 * in a graph, not an incident, and paging on it would train the owner to ignore the pager.
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("cron/db-health-snapshot", request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await captureQueryStatsSnapshot();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("pg_stat_statements snapshot failed — slow-query history has a gap", {
      labels: { event: "cron_failed", job: "db-health-snapshot" },
      error,
    });
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
