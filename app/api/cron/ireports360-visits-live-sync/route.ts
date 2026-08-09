import { NextResponse } from "next/server";

import { cairoTodayIso, isWithinLiveSyncWindow } from "@/lib/crm/dates";
import { runLiveIReports360Sync } from "@/lib/crm/sync";
import { notifyIReports360SyncResult } from "@/lib/notifications/ireports360-sync-digest";
import { logError } from "@/lib/observability/log";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { bearerSecretMatches } from "@/lib/security/constant-time";

const JOB_NAME = "ireports360-visits-live-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Same-day-only pull (see runLiveIReports360Sync) is far lighter than the 10-day rolling sync's
// 300s ceiling — kept modest rather than copying that value verbatim.
export const maxDuration = 120;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  // An unset CRON_SECRET may ONLY be bypassed on a real developer machine. This used to be
  // `!isProductionRuntime()`, which is true for ANY non-production APP_ENV — including staging,
  // a 1:1 clone of production. With CRON_SECRET unset there, all three iReports360 cron routes
  // would have been callable unauthenticated by anyone, driving vendor syncs and mirror writes
  // against production-grade data. Requiring NODE_ENV === "development" makes the bypass
  // impossible anywhere it is actually deployed.
  if (!secret) return process.env.NODE_ENV === "development";
  return bearerSecretMatches(request.headers.get("authorization"), secret);
}

async function runSync() {
  // The GCP schedule fires a little wider than the real 8:30 AM-12:01 PM Cairo compliance window
  // (see setup-gcp-cron.sh) so the schedule expression itself can stay a simple, even interval;
  // this is the one real, exact gate. A firing outside it is a cheap, intentional no-op rather
  // than a wasted vendor pull.
  if (!isWithinLiveSyncWindow()) {
    return NextResponse.json({ reason: "outside_live_sync_window", skipped: true });
  }

  const date = cairoTodayIso();
  try {
    const result = await runLiveIReports360Sync();
    // Deliberately no success notification here (unlike the 3x/day sync and weekly reconcile):
    // this job can fire up to ~15 times a morning, and a "sync succeeded" Telegram/in-app alert
    // that often would just be noise for the same Super Admin recipients those jobs already
    // notify. A real failure still alerts below.
    return NextResponse.json({ date, success: true, ...result });
  } catch (error) {
    await notifyIReports360SyncResult({
      dateFrom: date,
      dateTo: date,
      errorMessage: error instanceof Error ? error.message : String(error),
      jobName: JOB_NAME,
      status: "failed",
    }).catch((notifyError: unknown) => {
      logError("Failed to send iReports360 live-sync failure notification", { error: notifyError, labels: { job: JOB_NAME } });
    });
    throw error;
  }
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "unauthorized", message: "iReports360 live visits sync is not authorized." },
      { status: 401 },
    );
  }
  try {
    // Wrapped at the whole-request level (not just runLiveIReports360Sync) so an
    // outside-the-window no-op skip still sends an "ok" check-in — every GCP-scheduled
    // firing (including intentional skips) should count as a successful heartbeat. Same
    // reasoning extends to the dead-man's-switch slug below (phoenix-ireports360-live-sync,
    // matching the live Cloud Scheduler job name).
    return await withDeadMansSwitch("phoenix-ireports360-live-sync", () => runSync());
  } catch (error) {
    logError("iReports360 live visits sync failed", { error, labels: { event: "cron_failed", job: JOB_NAME } });
    const message = clientSafeErrorMessage(error, "iReports360 live visits sync failed.");
    return NextResponse.json({ error: "ireports360_live_visits_sync_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
