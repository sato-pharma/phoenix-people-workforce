import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import { runScheduledIReports360Sync } from "@/lib/visits-report/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  // Every Vercel environment (production, preview, `vercel dev`) sets VERCEL — only a
  // real local machine without it may bypass an unset CRON_SECRET during development.
  if (!secret) return !process.env.VERCEL && process.env.NODE_ENV === "development";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function runSync() {
  const result = await runScheduledIReports360Sync();
  return NextResponse.json({ success: true, ...result });
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "iReports360 visits sync is not authorized." }, { status: 401 });
  }
  try {
    // 09:00/12:00/19:00 UTC = 12pm/3pm/10pm Africa/Cairo (EEST, UTC+3 in summer) — matches the
    // existing daily dispatcher's UTC+3 calibration. Vercel cron has no DST awareness, so this
    // drifts an hour off in winter (EET, UTC+2), same known tradeoff as that existing cron.
    return await Sentry.withMonitor(
      "ireports360-visits-sync",
      runSync,
      {
        schedule: { type: "crontab", value: "0 9,12,19 * * *" },
        checkinMargin: 30,
        maxRuntime: 120,
        timezone: "Etc/UTC",
      },
    );
  } catch (error) {
    Sentry.captureException(error, { tags: { cron: "ireports360-visits-sync" } });
    const message = error instanceof Error ? error.message : "iReports360 visits sync failed.";
    return NextResponse.json({ error: "ireports360_visits_sync_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
