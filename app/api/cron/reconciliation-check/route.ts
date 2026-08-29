import { NextResponse } from "next/server";

import { notifyReconciliationBreach } from "@/lib/notifications/reconciliation-breach-alert";
import { logError } from "@/lib/observability/log";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { runReconciliationChecks } from "@/lib/reconciliation/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

const JOB_NAME = "reconciliation-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Sixteen checks, three at a time, several of them heavy production aggregates (the payroll batch
// sweep and the SoS dashboard fan-out). The same 300s ceiling already proven safe on the
// iReports360 sync and reconcile routes.
export const maxDuration = 300;

async function runReconciliation() {
  const report = await runReconciliationChecks();

  // Best-effort by contract. The report is the deliverable; a notification failure must not turn a
  // successful reconciliation run into a 500 and lose the findings entirely.
  const notification = await notifyReconciliationBreach(report).catch((error: unknown) => {
    logError("Failed to send reconciliation breach notification", {
      error,
      labels: { job: JOB_NAME },
    });
    return { delivered: 0, reason: clientSafeErrorMessage(error, "unknown error"), skipped: true };
  });

  return NextResponse.json({ success: true, notification, report });
}

export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/reconciliation-check", {
    message: "Reconciliation check is not authorized.",
  });
  if (denied) return denied;
  try {
    // Slug matches the scheduler job name, which is what the Healthchecks dead-man's switch pings.
    return await withDeadMansSwitch("phoenix-reconciliation-check", () => runReconciliation());
  } catch (error) {
    logError("Reconciliation check failed", { error, labels: { event: "cron_failed", job: JOB_NAME } });
    const message = clientSafeErrorMessage(error, "Reconciliation check failed.");
    return NextResponse.json({ error: "reconciliation_check_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
