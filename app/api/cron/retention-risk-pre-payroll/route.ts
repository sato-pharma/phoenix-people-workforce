import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { prePayrollPeriodLabel } from "@/lib/retention-risk/messages";
import { runRetentionRiskPrePayrollNotice } from "@/lib/retention-risk/notify";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The "take care, HR" notice, sent before payroll runs.
 *
 * Owner's instruction 2026-09-06: warn HR before the money moves, listing every employee currently
 * flagged. He chose BOTH timings when asked — this scheduled one on the 25th, several working days
 * before Part 1 pays at the start of the month, and a second one fired from the payroll wizard when
 * Part 1 is confirmed (see confirmPart1 in automated-payroll/run-service.ts). Neither suppresses
 * the other: `reason` is part of the idempotency key.
 *
 * It sends even when nobody is flagged. "Nobody is flagged" is the answer HR needs before payroll
 * just as much as a list is, and a notice that only ever appears when there is bad news cannot be
 * told apart from one that has quietly stopped working.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/retention-risk-pre-payroll");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-retention-risk-pre-payroll", () =>
      runRetentionRiskPrePayrollNotice("scheduled", prePayrollPeriodLabel()),
    );
    return NextResponse.json({
      success: true,
      notified: result.notified,
      signals: result.signals,
      skipped: result.skipped,
      warnings: result.warnings,
    });
  } catch (error) {
    logError("Retention risk pre-payroll notice failed", {
      labels: { event: "cron_failed", job: "retention-risk-pre-payroll" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Retention risk pre-payroll notice failed.");
    return NextResponse.json({ error: "retention_risk_pre_payroll_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
