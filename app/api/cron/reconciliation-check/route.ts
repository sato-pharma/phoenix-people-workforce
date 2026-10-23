import { NextResponse } from "next/server";

import { logError } from "@/lib/observability/log";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { runReconciliationChecks } from "@/lib/reconciliation/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertCronAuthorized } from "@/lib/security/cron-auth";
import { recordReconciliationRun } from "@/lib/system-audit/reconciliation-ledger";

const JOB_NAME = "reconciliation-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Twenty-two checks, three at a time, several of them heavy production aggregates (the payroll batch
// sweep and the SoS dashboard fan-out). The same 300s ceiling already proven safe on the
// iReports360 sync and reconcile routes.
export const maxDuration = 300;

async function runReconciliation() {
  const report = await runReconciliationChecks();

  // Best-effort by contract. The report is the deliverable; a ledger failure must not turn a
  // successful reconciliation run into a 500 and lose the findings entirely.
  //
  // There is NO separate breach notification any more (retired 2026-10-23). A breach is now a System
  // Audit issue, and the one daily System Audit message after the 04:57 sweep carries it alongside
  // everything else that is new, newly shared or reopened — one message a day, not one per source.
  const ledger = await recordReconciliationRun(report).catch((error: unknown) => {
    logError("Failed to record the reconciliation run in the System Audit ledger", {
      error,
      labels: { job: JOB_NAME },
    });
    return { recorded: false, reason: clientSafeErrorMessage(error, "unknown error") };
  });

  return NextResponse.json({ success: true, ledger, report });
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
