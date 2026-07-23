import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

import { isProductionRuntime } from "@/config/system-settings";
import { logCronUnauthorized, logError } from "@/lib/observability/log";
import { runNoActivityWeeklyReminder } from "@/lib/private-calendar/no-activity-clarifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Weekly, Friday 19:15 Cairo — deliberately a separate trigger from the 6:36 AM
// /api/notifications/daily cron, since "after 7 PM, Fridays" is a materially different
// schedule, not something that fits inside the existing morning batch.
function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !isProductionRuntime();
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function runWeekly(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "No-activity weekly reminder run is not authorized." }, { status: 401 });
  }
  const result = await runNoActivityWeeklyReminder();
  return NextResponse.json({ success: true, ...result });
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("notifications/no-activity-weekly", request);
    return NextResponse.json({ error: "unauthorized", message: "No-activity weekly reminder run is not authorized." }, { status: 401 });
  }
  try {
    return await Sentry.withMonitor("notifications-no-activity-weekly", () => runWeekly(request), {
      checkinMargin: 10,
      maxRuntime: 10,
      schedule: { type: "crontab", value: "15 19 * * 5" },
      timezone: "Africa/Cairo",
    });
  } catch (error) {
    logError("No-activity weekly reminder dispatcher failed", { labels: { event: "cron_failed", job: "notifications/no-activity-weekly" }, error });
    const message = error instanceof Error ? error.message : "No-activity weekly reminder run failed.";
    return NextResponse.json({ error: "no_activity_weekly_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
