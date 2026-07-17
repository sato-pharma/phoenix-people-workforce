import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/config/system-settings";

import { notifyIReports360SyncResult } from "@/lib/notifications/ireports360-sync-digest";
import { logError } from "@/lib/observability/log";
import { tickDvCheckboxesFromSync } from "@/lib/probation/feedback-service";
import { syncProbationDvDays } from "@/lib/probation/intelligence/dv-sync";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { runScheduledIReports360Sync } from "@/lib/crm/sync";

const JOB_NAME = "ireports360-visits-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Raised from 180 -> 300 (the same ceiling already proven safe on sales-upload/commit and the
// reconcile route) as a safety margin while the sync's own chunk-upsert loop is now parallelized
// (see upsertConcurrency in visits-report/service.ts) rather than a substitute for that fix.
export const maxDuration = 300;

// Matches runScheduledIReports360Sync's own lookback window (see visits-report/service.ts) —
// Double Visit Analytics has no separate sync step of its own (it reads ireports360_visits
// live), so this only drives the probation DV auto-tick over the same just-refreshed range.
const DV_TICK_LOOKBACK_DAYS = 10;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  // Every Vercel environment (production, preview, `vercel dev`) sets VERCEL — only a
  // real local machine without it may bypass an unset CRON_SECRET during development.
  if (!secret) return !isProductionRuntime();
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function isoDaysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

async function runSync() {
  // Computed up front (not just for the DV tick below) so the Telegram notification's window
  // labels match exactly what runScheduledIReports360Sync itself just pulled, in both the
  // success and failure branches below.
  const dateTo = isoDaysAgo(0);
  const dateFrom = isoDaysAgo(DV_TICK_LOOKBACK_DAYS);

  let mirrorSync: Awaited<ReturnType<typeof runScheduledIReports360Sync>>;
  try {
    mirrorSync = await runScheduledIReports360Sync();
  } catch (error) {
    await notifyIReports360SyncResult({
      dateFrom,
      dateTo,
      errorMessage: error instanceof Error ? error.message : String(error),
      jobName: JOB_NAME,
      status: "failed",
    }).catch((notifyError: unknown) => {
      logError("Failed to send iReports360 sync-failure notification", { error: notifyError, labels: { job: JOB_NAME } });
    });
    throw error;
  }

  // Auto-tick probation DV checkboxes for double visits in the just-refreshed window. Only
  // reached if the mirror sync above succeeded (it throws on failure, which short-circuits this
  // call). Never let a probation-tick failure mask an otherwise-successful visits sync.
  await tickDvCheckboxesFromSync(dateFrom, dateTo).catch((error: unknown) => {
    console.error(error, { tags: { cron: "ireports360-visits-sync-dv-tick" } });
  });

  // Capture validated probation DV-Days from the just-refreshed window into the new probation
  // domain (idempotent; scoped to probation employees). Non-blocking — a failure here must never
  // mask an otherwise-successful visits sync.
  await syncProbationDvDays(getSupabaseAdmin(), { dateFrom, dateTo }).catch((error: unknown) => {
    console.error(error, { tags: { cron: "ireports360-visits-sync-probation-dv" } });
  });

  await notifyIReports360SyncResult({
    dateFrom,
    dateTo,
    jobName: JOB_NAME,
    result: mirrorSync,
    runId: mirrorSync.runId,
    status: "success",
  }).catch((notifyError: unknown) => {
    logError("Failed to send iReports360 sync-success notification", { error: notifyError, labels: { job: JOB_NAME } });
  });

  return NextResponse.json({ success: true, ...mirrorSync });
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "iReports360 visits sync is not authorized." }, { status: 401 });
  }
  try {
    // 09:00/12:00/19:00 UTC = 12pm/3pm/10pm Africa/Cairo (EEST, UTC+3 in summer) — matches the
    // existing daily dispatcher's UTC+3 calibration. Vercel cron has no DST awareness, so this
    // drifts an hour off in winter (EET, UTC+2), same known tradeoff as that existing cron.
    return await runSync();
  } catch (error) {
    logError("iReports360 visits sync failed", { error, labels: { event: "cron_failed", job: JOB_NAME } });
    const message = error instanceof Error ? error.message : "iReports360 visits sync failed.";
    return NextResponse.json({ error: "ireports360_visits_sync_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
