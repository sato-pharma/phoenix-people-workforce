import { NextResponse } from "next/server";

import { logCronUnauthorized, logError } from "@/lib/observability/log";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { processBackgroundJobs } from "@/lib/background-jobs/worker";
import { notifyBackgroundJobsRun } from "@/lib/notifications/background-jobs-digest";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { bearerSecretMatches } from "@/lib/security/constant-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  // An unset CRON_SECRET may ONLY be bypassed on a real developer machine. Anything less
  // would leave this route callable unauthenticated wherever CRON_SECRET is unset —
  // including staging, which is a 1:1 clone of production data.
  if (!secret) return process.env.NODE_ENV === "development";
  return bearerSecretMatches(request.headers.get("authorization"), secret);
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
    // Slug matches the live Cloud Scheduler job name (phoenix-background-jobs).
    const result = await withDeadMansSwitch("phoenix-background-jobs", () => processBackgroundJobs(maxJobs));
    await notifyBackgroundJobsRun({ processed: result.processed, results: result.results, status: "success" }).catch(
      (notifyError: unknown) => {
        logError("Failed to send background-jobs run notification", { error: notifyError, labels: { job: "background-jobs" } });
      },
    );
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Background job worker failed", { labels: { event: "cron_failed", job: "background-jobs" }, error });
    const message = clientSafeErrorMessage(error, "Background job processing failed.");
    await notifyBackgroundJobsRun({ errorMessage: message, status: "failed" }).catch((notifyError: unknown) => {
      logError("Failed to send background-jobs failure notification", { error: notifyError, labels: { job: "background-jobs" } });
    });
    return NextResponse.json({ error: "background_jobs_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
