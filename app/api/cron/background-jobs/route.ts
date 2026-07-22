import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

import { isProductionRuntime } from "@/config/system-settings";
import { logCronUnauthorized, logError } from "@/lib/observability/log";
import { processBackgroundJobs } from "@/lib/background-jobs/worker";
import { notifyBackgroundJobsRun } from "@/lib/notifications/background-jobs-digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !isProductionRuntime();
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("cron/background-jobs", request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const limit = Number(new URL(request.url).searchParams.get("limit"));
    // Default raised 3 -> 10 (the route's own hard ceiling below) now that this only fires
    // once a week instead of every 10 minutes — a week's worth of admin-requested exports
    // should fully drain in one run rather than leaving some queued for another week.
    const maxJobs = Number.isFinite(limit) && limit > 0 ? Math.min(10, Math.floor(limit)) : 10;
    const result = await Sentry.withMonitor("background-jobs", () => processBackgroundJobs(maxJobs), {
      checkinMargin: 15,
      maxRuntime: 10,
      schedule: { type: "crontab", value: "0 3 * * 5" },
      timezone: "Africa/Cairo",
    });
    await notifyBackgroundJobsRun({ processed: result.processed, results: result.results, status: "success" }).catch(
      (notifyError: unknown) => {
        logError("Failed to send background-jobs run notification", { error: notifyError, labels: { job: "background-jobs" } });
      },
    );
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Background job worker failed", { labels: { event: "cron_failed", job: "background-jobs" }, error });
    const message = error instanceof Error ? error.message : "Background job processing failed.";
    await notifyBackgroundJobsRun({ errorMessage: message, status: "failed" }).catch((notifyError: unknown) => {
      logError("Failed to send background-jobs failure notification", { error: notifyError, labels: { job: "background-jobs" } });
    });
    return NextResponse.json({ error: "background_jobs_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
