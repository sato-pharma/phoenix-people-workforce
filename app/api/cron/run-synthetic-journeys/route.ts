import { NextResponse } from "next/server";

import { isProductionRuntime } from "@/config/system-settings";
import { dispatchSyntheticJourneys } from "@/lib/observability/dispatch-synthetic-journeys";
import { logCronUnauthorized, logError } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !isProductionRuntime();
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Run the production synthetic journeys now, on a schedule that actually fires.
 *
 * The Synthetic Journeys workflow declares its own `schedule:`, but GitHub does not honour it in
 * this repository. Measured 2026-08-05: both workflows added that day have never fired once, and
 * the only scheduled workflow that does fire (migration-drift-check, added 2026-07-20) lands 4.5-9h
 * after its nominal 07:00 — never on time in six days. cron-job.org, which already drives every
 * other /api/cron/* route, fires on time.
 *
 * So the trigger comes from there and lands here, and this route asks GitHub to start the run. The
 * GitHub token stays in Railway: pointing cron-job.org straight at GitHub's dispatch endpoint would
 * mean putting a write credential into a free-tier third-party account that AGENTS.md already
 * describes as a single point of failure. This way that account gains no GitHub access at all — it
 * presents the same CRON_SECRET it already holds.
 *
 * Returns promptly and does NOT wait for the run to finish. A synthetic run takes ~60s; waiting
 * would risk the false `Failed (timeout)` that cron-job.org's 30s cap already logs against
 * phoenix-notify-daily every morning. The run's own result is reported by the workflow.
 *
 * Returns 200 with `{ dispatched: false, reason }` when the token is unset — an unconfigured
 * deployment is a normal outcome, not a failure.
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("cron/run-synthetic-journeys", request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await dispatchSyntheticJourneys();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Synthetic journeys dispatch failed", {
      labels: { event: "synthetic_dispatch_failed" },
      error,
    });
    return NextResponse.json({ success: false, error: "dispatch_failed" }, { status: 500 });
  }
}
