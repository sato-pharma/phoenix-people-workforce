import { NextResponse } from "next/server";

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { runSalesPharmacyCodeSync } from "@/lib/marketing-requests/sales-code-sync";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const JOB_SLUG = "phoenix-marketing-pharmacy-code-sync";

/**
 * 02:47 Cairo, nightly (owner, 2026-11-03): the Sales -> Marketing pharmacy-code sync, which until now
 * ran only when somebody remembered. The rules are in src/lib/marketing-requests/sales-code-sync.ts.
 *
 * The switch is pinged directly so the night's counts land in the heartbeat detail, the one place they
 * are recorded. `?dryRun=1` reads the preflight and writes nothing.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/marketing-pharmacy-code-sync");
  if (denied) return denied;
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const result = await runSalesPharmacyCodeSync({ dryRun });
    if (!dryRun) await pingDeadMansSwitch(JOB_SLUG, "success", result.detail);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Pharmacy-code sync failed", {
      error,
      labels: { event: "cron_failed", job: "marketing-pharmacy-code-sync" },
    });
    if (!dryRun) await pingDeadMansSwitch(JOB_SLUG, "fail", describeThrown(error));
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Pharmacy-code sync failed.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
