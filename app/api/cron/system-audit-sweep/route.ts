import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";
import { runSystemAuditSweep } from "@/lib/system-audit/sweep";

const JOB_NAME = "system-audit-sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Six detectors one after another under a 240 s budget, then the daily message. The same 300 s
// ceiling the reconciliation check and the iReports360 routes already run inside.
export const maxDuration = 300;

async function runSweep() {
  const result = await runSystemAuditSweep();
  return NextResponse.json({ success: true, ...result });
}

export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/system-audit-sweep", {
    message: "System audit sweep is not authorized.",
  });
  if (denied) return denied;
  try {
    // Slug matches the scheduler job name, which is what the in-house heartbeat register watches.
    return await withDeadMansSwitch("phoenix-system-audit-sweep", () => runSweep());
  } catch (error) {
    logError("System audit sweep failed", { error, labels: { event: "cron_failed", job: JOB_NAME } });
    const message = clientSafeErrorMessage(error, "System audit sweep failed.");
    return NextResponse.json({ error: "system_audit_sweep_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
