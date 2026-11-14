import { NextResponse } from "next/server";

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { runMasterRecheck } from "@/lib/marketing-requests/master-recheck";
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
 *
 * After the sync, the master re-check (REC-077, src/lib/marketing-requests/master-recheck.ts) matches the
 * unresolved codes nobody has decided on against the sales master the sync just refreshed, and counts the
 * person-decided ones waiting in Marketing Control. Its counts join the detail; if it fails, the sync's
 * own counts are still reported and the night reads as failed.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/marketing-pharmacy-code-sync");
  if (denied) return denied;
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const result = await runSalesPharmacyCodeSync({ dryRun });
    let recheck;
    try {
      recheck = await runMasterRecheck({ dryRun });
    } catch (recheckError) {
      logError("Pharmacy-code master re-check failed", {
        error: recheckError,
        labels: { event: "cron_failed", job: "marketing-pharmacy-code-recheck" },
      });
      const detail = `${result.detail} · re-check failed: ${describeThrown(recheckError)}`;
      if (!dryRun) await pingDeadMansSwitch(JOB_SLUG, "fail", detail);
      return NextResponse.json(
        { success: false, ...result, detail, error: clientSafeErrorMessage(recheckError, "Pharmacy-code re-check failed.") },
        { status: 500 },
      );
    }
    const detail = `${result.detail} · ${recheck.detail}`;
    if (!dryRun) await pingDeadMansSwitch(JOB_SLUG, "success", detail);
    return NextResponse.json({ success: true, ...result, detail, recheck });
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
