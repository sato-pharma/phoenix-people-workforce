import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { isProductionRuntime } from "@/config/system-settings";

import { notifyIReports360SyncResult } from "@/lib/notifications/ireports360-sync-digest";
import { logError } from "@/lib/observability/log";
import { resolveWideReconciliationSlice, runWideIReports360Reconciliation } from "@/lib/crm/sync";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { syncProbationDvDays } from "@/lib/probation/intelligence/dv-sync";
import { tickDvCheckboxesFromSync } from "@/lib/probation/feedback-service";

const JOB_NAME = "ireports360-visits-reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 300s is the highest maxDuration already proven safe on this Vercel plan (see
// app/api/sales/sales-upload/commit/route.ts). Even so, a full 120-day reconciliation
// (fetch + upsert + delete-reconciliation + check-in reconciliation + FWC snapshot refresh)
// may still exceed this under heavy CRM load - see the 2026-07-06 investigation note in
// runWideIReports360Reconciliation's doc comment for the follow-up if this keeps timing out.
export const maxDuration = 300;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  // Every Vercel environment (production, preview, `vercel dev`) sets VERCEL — only a
  // real local machine without it may bypass an unset CRON_SECRET during development.
  if (!secret) return !isProductionRuntime();
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function runReconcile() {
  // Same slice resolveWideReconciliationSlice-derived window runWideIReports360Reconciliation
  // itself just used, so the Telegram notification's window labels line up exactly with what
  // was actually pulled.
  const { dateFrom, dateTo } = resolveWideReconciliationSlice(new Date());

  let result: Awaited<ReturnType<typeof runWideIReports360Reconciliation>>;
  try {
    result = await Sentry.withMonitor("ireports360-visits-reconcile", () => runWideIReports360Reconciliation(), {
      checkinMargin: 15,
      maxRuntime: 10,
      schedule: { type: "crontab", value: "24 4 * * 0" },
      timezone: "Africa/Cairo",
    });
  } catch (error) {
    await notifyIReports360SyncResult({
      dateFrom,
      dateTo,
      errorMessage: error instanceof Error ? error.message : String(error),
      jobName: JOB_NAME,
      status: "failed",
    }).catch((notifyError: unknown) => {
      logError("Failed to send iReports360 reconcile-failure notification", { error: notifyError, labels: { job: JOB_NAME } });
    });
    throw error;
  }

  // The wide reconcile can newly land a double visit whose visit_date is OLDER than the daily
  // sync's 10-day window, so the daily cron's probation steps never see it (DV shows in Double
  // Visit Analytics but never reaches probation checkboxes / probation_dv_days). Run them here too,
  // over this slice's window, so probation stays complete. Both are idempotent + cohort-scoped, and
  // each is isolated (a probation failure must never fail the reconcile).
  await tickDvCheckboxesFromSync(dateFrom, dateTo).catch((error: unknown) => {
    logError("iReports360 reconcile DV-checkbox tick failed", { error, labels: { job: JOB_NAME } });
  });
  await syncProbationDvDays(getSupabaseAdmin(), { dateFrom, dateTo }).catch((error: unknown) => {
    logError("iReports360 reconcile probation DV-day sync failed", { error, labels: { job: JOB_NAME } });
  });

  await notifyIReports360SyncResult({
    dateFrom,
    dateTo,
    jobName: JOB_NAME,
    result,
    runId: result.runId,
    status: "success",
  }).catch((notifyError: unknown) => {
    logError("Failed to send iReports360 reconcile-success notification", { error: notifyError, labels: { job: JOB_NAME } });
  });

  return NextResponse.json({ success: true, ...result });
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "iReports360 wide reconciliation is not authorized." }, { status: 401 });
  }
  try {
    return await runReconcile();
  } catch (error) {
    logError("iReports360 wide reconciliation failed", { error, labels: { event: "cron_failed", job: JOB_NAME } });
    const message = error instanceof Error ? error.message : "iReports360 wide reconciliation failed.";
    return NextResponse.json({ error: "ireports360_visits_reconcile_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
