import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { runRetentionRiskSweep } from "@/lib/retention-risk/notify";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The daily retention-risk sweep: who has five or more consecutive working days of recorded leave,
 * and which Medical Rep has five or more with no CRM entry at all.
 *
 * WHY IT EXISTS. Payroll pays Part 1 at the start of the month and Part 2 the day after, and reps
 * collect both and resign immediately. Measured on production 2026-09-06: 23 of 59 recorded
 * resignations land in the first ten days of a month, five medical reps resigned on 9 August alone,
 * and four of those five had already stopped logging CRM entries five or more days earlier. Nothing
 * in the system said a word.
 *
 * 07:40 Cairo — after the morning CRM sync and after the 07:20 distributor nudge, so the visits
 * mirror is fresh before this reads it, and a clock of its own rather than another sub-job on
 * `phoenix-notify-daily`, which was then at cron-job.org's unraisable 30-second cut (that bundle was
 * split into one job per schedule on 13 Nov 2026).
 *
 * Safe to run repeatedly: the idempotency key carries each run's START date, so a person is
 * announced once per streak and never again while that streak continues.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/retention-risk-sweep");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-retention-risk-sweep", () => runRetentionRiskSweep());
    return NextResponse.json({
      success: true,
      announced: result.announced,
      notified: result.notified,
      signals: result.signals,
      skipped: result.skipped,
      warnings: result.warnings,
    });
  } catch (error) {
    logError("Retention risk sweep failed", {
      labels: { event: "cron_failed", job: "retention-risk-sweep" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Retention risk sweep failed.");
    return NextResponse.json({ error: "retention_risk_sweep_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
