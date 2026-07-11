import { NextResponse } from "next/server";

import { isProductionRuntime } from "@/config/system-settings";
import { logCronUnauthorized, logError } from "@/lib/observability/log";
import { processBackgroundJobs } from "@/lib/background-jobs/worker";

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
    const maxJobs = Number.isFinite(limit) && limit > 0 ? Math.min(10, Math.floor(limit)) : 3;
    const result = await processBackgroundJobs(maxJobs);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Background job worker failed", { labels: { event: "cron_failed", job: "background-jobs" }, error });
    const message = error instanceof Error ? error.message : "Background job processing failed.";
    return NextResponse.json({ error: "background_jobs_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
