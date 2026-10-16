import { NextResponse } from "next/server";

import { notifyIReports360SyncResult } from "@/lib/notifications/ireports360-sync-digest";
import { logError } from "@/lib/observability/log";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { syncProbationDvDays } from "@/lib/probation/intelligence/dv-sync";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { runScheduledIReports360Sync } from "@/lib/crm/sync";
import { resolveVendorSyncStandDown } from "@/lib/crm/cutover";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

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

  // A tickDvCheckboxesFromSync() call stood here until 2026-09-01. It ticked the
  // dm/nsm/pm_gpm/tm_dv_done booleans on employee_probation — a table the hire trigger stopped
  // filling when the Case model landed — so it had been updating ZERO rows on every run. It went
  // with the rest of the legacy feedback path. syncProbationDvDays below is the live DV pipeline
  // and is deliberately untouched: it feeds probation_dv_days, which is what the Case model reads.

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
  const denied = assertCronAuthorized(request, "cron/ireports360-visits-sync", {
    message: "iReports360 visits sync is not authorized.",
  });
  if (denied) return denied;
  // THE CRM CUTOVER. Once iReports360 is retired there is nothing to pull; answer before the
  // dead-man's switch so a retired job never pings (docs/crm-cutover-runbook.md). The probation
  // double-visit capture below moves to src/lib/crm/housekeeping-scheduler.ts.
  const standDown = await resolveVendorSyncStandDown();
  if (standDown) return NextResponse.json({ reason: standDown, skipped: true });
  try {
    // Scheduled at 9:07/12:07/19:07 Africa/Cairo via Google Cloud Scheduler's --time-zone flag
    // (see scripts/setup-gcp-cron.sh), which is genuinely DST-aware — the trigger stays pinned
    // to Cairo wall-clock time across the EET/EEST transition. The app server itself still runs
    // in UTC (Cloud Run), so any in-app "now" logic must still resolve via Africa/Cairo, not the
    // server clock.
    // Slug matches the live Cloud Scheduler job name (phoenix-ireports360-sync), not JOB_NAME
    // above ("ireports360-visits-sync") — the Healthchecks check uses this slug.
    // `signalStart`: a run cut off mid-sync reads "started, never finished" at Healthchecks.
    return await withDeadMansSwitch("phoenix-ireports360-sync", () => runSync(), { signalStart: true });
  } catch (error) {
    logError("iReports360 visits sync failed", { error, labels: { event: "cron_failed", job: JOB_NAME } });
    const message = clientSafeErrorMessage(error, "iReports360 visits sync failed.");
    return NextResponse.json({ error: "ireports360_visits_sync_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
